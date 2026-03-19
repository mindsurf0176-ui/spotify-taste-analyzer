#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const { URL, URLSearchParams } = require('url');

const TOOL_NAME = 'spotify-taste-analyzer (on-disk: spotify-classical-bridge)';
const USER_AGENT = `${TOOL_NAME}/0.2.0`;
const TOKEN_FILE = path.join(__dirname, '.spotify-tokens.json');
const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8765/callback';
const SPOTIFY_ACCOUNTS_BASE = 'https://accounts.spotify.com';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

function isSpotifyPlaylist(input) {
  return /open\.spotify\.com\/playlist|spotify:playlist:/i.test(input);
}

function isSpotifyProfile(input) {
  return /open\.spotify\.com\/(user|artist)|spotify:(user|artist):/i.test(input);
}

function request(url, options = {}, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'http:' ? http : https;
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search || ''}`,
        method: options.method || 'GET',
        headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    req.setTimeout(options.timeout || 12000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

function parseJsonResponse(response, context) {
  let parsed = null;
  if (response.body) {
    try {
      parsed = JSON.parse(response.body);
    } catch (err) {
      throw new Error(`${context} returned non-JSON response`);
    }
  }
  if (response.statusCode >= 400) {
    const message = (parsed && parsed.error_description) || (parsed && parsed.error && parsed.error.message) || (parsed && parsed.error) || `HTTP ${response.statusCode}`;
    throw new Error(`${context} failed: ${message}`);
  }
  return parsed;
}

function uniq(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function incrementMap(map, key, amount = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + amount;
}

function normalizeGenre(genre) {
  return String(genre || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Lightweight heuristics (unchanged)
function inferGenresAndMoods(items) {
  const mapping = [
    { re: /radiohead/i, genres: ['alt rock', 'art rock'], moods: ['brooding', 'introspective', 'textured'] },
    { re: /slowdive|my bloody valentine|shoegaze/i, genres: ['shoegaze', 'dream pop'], moods: ['reverb-drenched', 'ethereal'] },
    { re: /mogwai|explosions in the sky|godspeed/i, genres: ['post-rock', 'instrumental rock'], moods: ['cinematic', 'expansive'] },
    { re: /sigur ros|bjork/i, genres: ['post-rock', 'experimental'], moods: ['otherworldly', 'lush'] },
    { re: /interpol|the strokes|joy division/i, genres: ['indie rock', 'post-punk'], moods: ['angular', 'cool'] },
    { re: /phoebe bridgers|sufjan|bon iver/i, genres: ['indie folk', 'indie'], moods: ['melancholic', 'intimate'] },
    { re: /shoegaze|dreampop/i, genres: ['shoegaze', 'dream pop'], moods: ['washy', 'reverb-heavy'] },
    { re: /keshi|wave to earth|92914|the black skirts/i, genres: ['indie', 'k-indie', 'bedroom pop'], moods: ['dreamy', 'melancholic', 'soft'] },
    { re: /age factory|w\.o\.d\.|tricot|toe|lite/i, genres: ['j-rock', 'math rock', 'post-hardcore'], moods: ['intense', 'angular', 'driving'] },
    { re: /king gnu|vaundy|fujii kaze|yoasobi|yorushika/i, genres: ['j-pop', 'j-rock', 'alternative'], moods: ['dynamic', 'polished', 'emotional'] },
    { re: /dpr live|crush|dean|ph-1|penomeco|giriboy|heize|meenoi|oceanfromtheblue/i, genres: ['k-r&b', 'k-hiphop', 'korean r&b'], moods: ['smooth', 'nocturnal', 'chill'] },
    { re: /deftones|nothing|whirr|hum/i, genres: ['shoegaze', 'alternative metal', 'nu-gaze'], moods: ['heavy', 'dreamy', 'massive'] },
    { re: /dominic fike|kevin abstract|brockhampton|steve lacy/i, genres: ['alt pop', 'indie pop', 'experimental pop'], moods: ['playful', 'eclectic', 'vibrant'] },
    { re: /fontaines d\.?c\.?|idles|shame|squid/i, genres: ['post-punk', 'art punk'], moods: ['abrasive', 'urgent', 'raw'] },
    { re: /kurayamisaka|joseon|parannoul|se so neon/i, genres: ['shoegaze', 'noise pop', 'k-indie'], moods: ['wall-of-sound', 'ethereal', 'raw'] },
    { re: /starfall|wilt|basement|nothing but thieves/i, genres: ['emo', 'alt rock', 'post-hardcore'], moods: ['emotional', 'cathartic', 'intense'] },
    { re: /king krule/i, genres: ['art rock', 'dark jazz', 'lo-fi'], moods: ['brooding', 'nocturnal', 'gritty'] },
  ];
  const genreCounts = {};
  const moodCounts = {};
  (items || []).forEach((it) => {
    for (const entry of mapping) {
      if (entry.re.test(it)) {
        entry.genres.forEach((g) => incrementMap(genreCounts, g));
        entry.moods.forEach((m) => incrementMap(moodCounts, m));
      }
    }
  });
  if (Object.keys(genreCounts).length === 0) {
    (items || []).forEach((it) => {
      if (/guitar|band|rock|indie/i.test(it)) incrementMap(genreCounts, 'indie/alt');
      if (/ambient|drone|reverb|soundscape/i.test(it)) incrementMap(moodCounts, 'ambient');
    });
  }
  return {
    genres: Object.entries(genreCounts).sort((a, b) => b[1] - a[1]).map((e) => e[0]),
    moods: Object.entries(moodCounts).sort((a, b) => b[1] - a[1]).map((e) => e[0]),
  };
}

function deriveClustersFromGenres(genres) {
  const clusterRules = [
    { name: 'Atmospheric haze', re: /shoegaze|dream pop|ethereal wave|ambient pop/ },
    { name: 'Cinematic build', re: /post-rock|instrumental rock|soundtrack|epicore/ },
    { name: 'Angular art-rock', re: /art rock|post-punk|indie rock|alternative rock/ },
    { name: 'Soft melancholy', re: /indie folk|singer-songwriter|chamber pop|slowcore/ },
    { name: 'Electronic drift', re: /idm|ambient|downtempo|trip hop|electronica/ },
    { name: 'Heavy atmosphere', re: /metal|doom|blackgaze|sludge/ },
    { name: 'J-rock intensity', re: /j-rock|math rock|japanese|post-hardcore/ },
    { name: 'K-indie dreaming', re: /k-indie|korean|k-r&b|k-hiphop|bedroom pop/ },
    { name: 'Nu-gaze heaviness', re: /nu-gaze|alternative metal|noise pop|blackgaze/ },
  ];
  const counts = {};
  (genres || []).forEach((genre) => {
    const normalized = normalizeGenre(genre);
    clusterRules.forEach((rule) => {
      if (rule.re.test(normalized)) incrementMap(counts, rule.name);
    });
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map((e) => e[0]);
}

function deriveMoodDescriptors(genres, names) {
  const moodRules = [
    { re: /shoegaze|dream pop|ambient|ethereal/, values: ['diffuse', 'glowing', 'immersive'] },
    { re: /post-rock|soundtrack|cinematic/, values: ['cinematic', 'patient', 'surging'] },
    { re: /indie folk|chamber pop|singer-songwriter/, values: ['intimate', 'melancholic', 'warm-grained'] },
    { re: /art rock|experimental|post-punk/, values: ['restless', 'brooding', 'textured'] },
    { re: /metal|doom|blackgaze/, values: ['massive', 'dark-edged', 'cathedral-scale'] },
    { re: /idm|trip hop|downtempo|electronica/, values: ['hypnotic', 'nocturnal', 'precise'] },
    { re: /j-rock|math rock|post-hardcore/, values: ['angular', 'driving', 'intense'] },
    { re: /k-indie|bedroom pop|korean r&b|k-r&b/, values: ['dreamy', 'melancholic', 'smooth'] },
    { re: /noise pop|nu-gaze|wall-of-sound/, values: ['massive', 'saturated', 'enveloping'] },
  ];
  const counts = {};
  ([... (genres || []), ... (names || [])]).forEach((value) => {
    moodRules.forEach((rule) => {
      if (rule.re.test(String(value).toLowerCase())) rule.values.forEach((v) => incrementMap(counts, v));
    });
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map((e) => e[0]);
}

function printHelp() {
  console.log(`\n${TOOL_NAME} - CLI account & playlist listener taste analyzer\n\nUsage:\n  node index.js help\n  node index.js auth\n  node index.js login\n  node index.js auth --no-open\n  node index.js auth --code <authorization_code>\n  node index.js analyze-me --term medium_term --limit 10 [--full] [--with-recent] [--with-library] [--html]\n  node index.js "Radiohead, Slowdive, Mogwai"\n  node index.js "https://open.spotify.com/playlist/..."\n  node index.js "https://open.spotify.com/user/..."\n\nCommands:\n  help          Show this help text\n  auth, login   Start Spotify OAuth authorization code flow for this CLI\n  logout        Delete the locally stored token file\n  analyze-me    Use stored OAuth tokens to analyze your Spotify top artists/tracks\n\nFlags:\n  --term <value>    Spotify time range: short_term, medium_term, long_term\n  --limit <value>   Result limit for top artists/tracks (1-50, default 10)\n  --no-open         Print auth URL without trying to open the browser\n  --code <value>    Exchange a pasted Spotify authorization code manually\n  --full            Shortcut for analyze-me: enable both --with-recent and --with-library
  --with-recent     When used with analyze-me, also fetch your recently-played tracks (up to 10) and include a short 'rotation/drift' section
  --with-library    When used with analyze-me, also sample your saved tracks / liked songs (up to 20) and add a saved-library snapshot + comparison
  --html            Generate a beautiful HTML report and auto-open in browser\n\nEnvironment variables for real Spotify auth:\n  SPOTIFY_CLIENT_ID\n  SPOTIFY_CLIENT_SECRET\n  SPOTIFY_REDIRECT_URI   Optional, defaults to ${DEFAULT_REDIRECT_URI}\n\nToken storage:\n  ${TOKEN_FILE}\n  The tool will try to create/update this file with mode 600.\n\nNotes:\n  - Real Spotify credentials are required for auth and analyze-me.\n  - No-auth fallback modes still work without credentials: profile URL, playlist URL, pasted artists/tracks.\n  - IMPORTANT: This version requests additional Spotify scopes (user-read-recently-played, user-library-read). If you previously authorized the CLI, you MUST re-run \"node index.js auth\" (or login) to grant the new scopes and obtain refreshed tokens.\n`);
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < (argv || []).length; i += 1) {
    const value = argv[i];
    if (!value) continue;
    if (value === '--help' || value === '-h') { positional.push(value); continue; }
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const key = value.slice(2);
    if (key === 'no-open') { options.noOpen = true; continue; }
    if (key === 'full') { options.full = true; continue; }
    if (key === 'with-recent') { options.withRecent = true; continue; }
    if (key === 'with-library') { options.withLibrary = true; continue; }
    if (key === 'html') { options.html = true; continue; }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = next; i += 1;
  }
  return { positional, options };
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(String(answer || '').trim()); }));
}

function getSpotifyConfig() {
  return { clientId: process.env.SPOTIFY_CLIENT_ID || '', clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '', redirectUri: process.env.SPOTIFY_REDIRECT_URI || DEFAULT_REDIRECT_URI };
}

function requireSpotifyCredentials() {
  const config = getSpotifyConfig();
  if (!config.clientId || !config.clientSecret) throw new Error('Spotify auth requires SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in the environment. No auth was attempted.');
  return config;
}

function buildAuthorizeUrl(config, state) {
  // NOTE: Added user-read-recently-played and user-library-read to requested scopes. If you previously authorized the CLI, you MUST re-run auth/login.
  const params = new URLSearchParams({ client_id: config.clientId, response_type: 'code', redirect_uri: config.redirectUri, scope: 'user-top-read user-read-recently-played user-library-read', state, show_dialog: 'false' });
  return `${SPOTIFY_ACCOUNTS_BASE}/authorize?${params.toString()}`;
}

function canUseLocalCallback(redirectUri) {
  try { const parsed = new URL(redirectUri); return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname); } catch (err) { return false; }
}

function openBrowser(url) { if (process.platform !== 'darwin') return false; const child = spawn('open', [url], { stdio: 'ignore', detached: true }); child.on('error', () => {}); child.unref(); return true; }

function waitForCallback(redirectUri, expectedState) {
  const parsed = new URL(redirectUri);
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const incoming = new URL(req.url, redirectUri);
      if (incoming.pathname !== parsed.pathname) { res.statusCode = 404; res.end('Not found'); return; }
      const code = incoming.searchParams.get('code');
      const state = incoming.searchParams.get('state');
      const error = incoming.searchParams.get('error');
      if (error) { res.statusCode = 400; res.end(`Spotify authorization failed: ${error}`); cleanup(new Error(`Spotify authorization failed: ${error}`)); return; }
      if (!code) { res.statusCode = 400; res.end('Missing authorization code'); cleanup(new Error('Spotify redirect did not include an authorization code')); return; }
      if (state !== expectedState) { res.statusCode = 400; res.end('State mismatch'); cleanup(new Error('Spotify redirect state mismatch')); return; }
      res.statusCode = 200; res.setHeader('content-type', 'text/plain; charset=utf-8'); res.end('Spotify authorization received. You can return to the terminal.'); cleanup(null, code);
    });
    const timer = setTimeout(() => cleanup(new Error('Timed out waiting for Spotify redirect on local callback server')), 120000);
    function cleanup(err, code) { clearTimeout(timer); server.close(() => { if (err) reject(err); else resolve(code); }); }
    server.on('error', reject); server.listen(Number(parsed.port), parsed.hostname);
  });
}

async function exchangeCodeForTokens(config, code) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri }).toString();
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const response = await request(`${SPOTIFY_ACCOUNTS_BASE}/api/token`, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' } }, body);
  const parsed = parseJsonResponse(response, 'Spotify token exchange');
  return { access_token: parsed.access_token, refresh_token: parsed.refresh_token, scope: parsed.scope, token_type: parsed.token_type, expires_in: parsed.expires_in, expires_at: Date.now() + parsed.expires_in * 1000, obtained_at: new Date().toISOString() };
}

async function refreshAccessToken(config, refreshToken) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString();
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const response = await request(`${SPOTIFY_ACCOUNTS_BASE}/api/token`, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' } }, body);
  const parsed = parseJsonResponse(response, 'Spotify token refresh');
  return { access_token: parsed.access_token, refresh_token: parsed.refresh_token || refreshToken, scope: parsed.scope, token_type: parsed.token_type, expires_in: parsed.expires_in, expires_at: Date.now() + parsed.expires_in * 1000, obtained_at: new Date().toISOString() };
}

function writeTokenFile(tokens) { const payload = JSON.stringify(tokens, null, 2); fs.writeFileSync(TOKEN_FILE, payload, { mode: 0o600 }); try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (err) {} }
function readTokenFile() { if (!fs.existsSync(TOKEN_FILE)) return null; return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); }

async function getValidTokens() {
  const config = requireSpotifyCredentials();
  const stored = readTokenFile();
  if (!stored || !stored.access_token) throw new Error(`No stored Spotify token found at ${TOKEN_FILE}. Run "node index.js auth" first.`);
  if (stored.expires_at && stored.expires_at > Date.now() + 30000) return stored;
  if (!stored.refresh_token) throw new Error(`Stored Spotify token expired and no refresh token is available in ${TOKEN_FILE}. Run auth again.`);
  const refreshed = await refreshAccessToken(config, stored.refresh_token);
  const merged = { ...stored, ...refreshed };
  writeTokenFile(merged);
  return merged;
}

async function spotifyApiGet(pathname, accessToken) { const response = await request(`${SPOTIFY_API_BASE}${pathname}`, { headers: { Authorization: `Bearer ${accessToken}` } }); return parseJsonResponse(response, `Spotify API ${pathname}`); }

async function runAuth(options) {
  const config = requireSpotifyCredentials();
  let code = options.code;
  if (!code) {
    const state = crypto.randomBytes(16).toString('hex');
    const authUrl = buildAuthorizeUrl(config, state);
    console.log('Spotify authorization URL:\n'); console.log(authUrl); console.log('');
    let callbackPromise = null;
    if (canUseLocalCallback(config.redirectUri)) callbackPromise = waitForCallback(config.redirectUri, state).catch((err) => { console.log(`Local callback capture failed: ${err.message}`); return null; });
    else console.log(`Redirect URI ${config.redirectUri} is not a local http callback, so paste-back mode will be used.`);
    if (!options.noOpen) { const opened = openBrowser(authUrl); if (!opened) console.log('Browser auto-open is only attempted on macOS. Open the URL manually if needed.'); }
    if (callbackPromise) code = await callbackPromise;
    if (!code) code = await ask('Paste the Spotify authorization code: ');
  }
  if (!code) throw new Error('No authorization code provided, so no token exchange was attempted.');
  const tokens = await exchangeCodeForTokens(config, code);
  writeTokenFile(tokens);
  console.log(`Spotify tokens stored in ${TOKEN_FILE}`);
}

function summarizeTopItems(items, formatter) { return (items || []).map((item, index) => `${index + 1}. ${formatter(item)}`).join('\n'); }

function analyzeListeningProfile(topArtists, topTracks) {
  const artistNames = (topArtists || []).map((a) => a.name);
  const topArtistGenres = uniq((topArtists || []).flatMap((a) => a.genres || []));
  const trackNames = (topTracks || []).map((t) => t.name);
  const trackArtistNames = uniq((topTracks || []).flatMap((t) => (t.artists || []).map((a) => a.name)));
  const heuristic = inferGenresAndMoods([...artistNames, ...trackArtistNames, ...trackNames]);
  const genreCounts = {};
  topArtistGenres.forEach((g) => incrementMap(genreCounts, g, 2));
  heuristic.genres.forEach((g) => incrementMap(genreCounts, g));
  const sortedGenres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  const clusters = deriveClustersFromGenres(sortedGenres);
  const moods = uniq([...deriveMoodDescriptors(sortedGenres, [...artistNames, ...trackNames]), ...heuristic.moods]).slice(0, 8);
  return { genreClusters: clusters.length ? clusters : sortedGenres.slice(0, 4), genres: sortedGenres.slice(0, 10), moods };
}

function summarizeSavedLibrary(savedTracks, topArtists, topTracks) {
  const items = (savedTracks && Array.isArray(savedTracks.items) ? savedTracks.items : []).map((item) => item.track || {}).filter((track) => track && (track.name || (track.artists || []).length));
  const snapshot = items.slice(0, 10).map((track, index) => `${index + 1}. ${track.name || '(unknown)'} - ${((track.artists || []).map((artist) => artist.name).join(', ')) || '(unknown artist)'}`);
  const savedArtistNames = uniq(items.flatMap((track) => (track.artists || []).map((artist) => artist.name)));
  const savedTrackNames = items.map((track) => track.name).filter(Boolean);
  const genreHints = uniq(savedArtistNames.flatMap((artistName) => {
    const match = (topArtists || []).find((artist) => artist.name === artistName);
    return match && Array.isArray(match.genres) ? match.genres : [];
  }));
  const heuristic = inferGenresAndMoods([...savedArtistNames, ...savedTrackNames, ...genreHints]);
  const signatureGenres = uniq([...genreHints, ...heuristic.genres]).slice(0, 4);
  const signatureMoods = uniq([...deriveMoodDescriptors(signatureGenres, [...savedArtistNames, ...savedTrackNames]), ...heuristic.moods]).slice(0, 4);
  const signatureArtists = savedArtistNames.slice(0, 3).join(', ') || 'a small cross-section of your library';
  let signature = `This saved-track sample centers on ${signatureArtists}`;
  if (signatureGenres.length) signature += `, leaning ${signatureGenres.join(', ')}`;
  if (signatureMoods.length) signature += ` with a ${signatureMoods.join(', ')} feel`;
  signature += '.';

  const topTrackIds = new Set((topTracks || []).map((track) => track.id).filter(Boolean));
  const topArtistNames = new Set((topArtists || []).map((artist) => artist.name));
  let trackOverlap = 0;
  items.forEach((track) => {
    if (track.id && topTrackIds.has(track.id)) trackOverlap += 1;
  });
  const artistOverlap = savedArtistNames.filter((artistName) => topArtistNames.has(artistName)).length;
  const trackPct = items.length ? Math.round((trackOverlap / items.length) * 100) : 0;
  const artistPct = savedArtistNames.length ? Math.round((artistOverlap / savedArtistNames.length) * 100) : 0;
  const comparison = `Track overlap with your top tracks: ${trackOverlap}/${items.length || 0} (${trackPct}%). Artist overlap with your top artists: ${artistOverlap}/${savedArtistNames.length || 0} (${artistPct}%).`;

  return { snapshot, signature, comparison };
}

function escapeHtml(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateHtmlReport(data) {
  const { user, termResults, termLabels = {}, termEmojis = {}, recentPlayed, savedLibrary, generatedAt } = data;
  const displayName = escapeHtml(user.display_name || 'Spotify Listener');
  const profileImage = user.images && user.images.length ? user.images[user.images.length - 1].url : '';
  const allTerms = ['short_term', 'medium_term', 'long_term'];
  const resolvedTermLabels = {
    short_term: 'Last 4 Weeks',
    medium_term: 'Last 6 Months',
    long_term: 'All Time',
    ...termLabels,
  };
  const resolvedTermEmojis = {
    short_term: '🕐',
    medium_term: '📅',
    long_term: '⭐',
    ...termEmojis,
  };

  // Pill colors for genre tags
  const pillColors = ['#1DB954', '#1ed760', '#b388ff', '#ff6e91', '#64ffda', '#ffd740', '#69f0ae', '#ea80fc', '#ff8a80', '#82b1ff', '#ccff90', '#ff9e80'];
  function pillColor(index) { return pillColors[index % pillColors.length]; }

  // Build per-term sections
  const termSectionsHtml = allTerms.map((t, termIdx) => {
    const tr = termResults[t];
    if (!tr) return '';
    const artists = tr.artists || [];
    const tracks = tr.tracks || [];
    const analysis = tr.analysis || { genres: [], genreClusters: [], moods: [] };
    const label = resolvedTermLabels[t] || t;
    const icon = resolvedTermEmojis[t] || '🎵';
    const delay = termIdx * 0.3;

    // Genre bar chart data
    const genreBarMax = analysis.genres.length ? analysis.genres.length : 1;
    const genreBars = analysis.genres.slice(0, 10).map((g, i) => {
      const pct = Math.round(((genreBarMax - i) / genreBarMax) * 100);
      return `<div class="genre-bar"><span class="genre-label">${escapeHtml(g)}</span><div class="genre-bar-track"><div class="genre-bar-fill" style="width:${pct}%"></div></div></div>`;
    }).join('\n');

    // Top Artists cards
    const artistCards = artists.map((artist, i) => {
      const img = artist.images && artist.images.length ? artist.images[artist.images.length > 1 ? 1 : 0].url : '';
      let artistGenres = (artist.genres || []).slice(0, 4);
      if (!artistGenres.length) {
        const inferred = inferGenresAndMoods([artist.name]);
        artistGenres = inferred.genres.slice(0, 4);
      }
      const genres = artistGenres.map((g, gi) =>
        `<span class="pill" style="background:${pillColor(i * 4 + gi)}">${escapeHtml(g)}</span>`
      ).join('');
      return `<div class="artist-card">
        ${img ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(artist.name)}" class="artist-img" loading="lazy" />` : `<div class="artist-img artist-img-placeholder">${escapeHtml(artist.name.charAt(0))}</div>`}
        <div class="artist-info">
          <div class="artist-name">${escapeHtml(artist.name)}</div>
          <div class="artist-genres">${genres || '<span class="pill pill-muted">no genres listed</span>'}</div>
        </div>
      </div>`;
    }).join('\n');

    // Top Tracks list
    const trackRows = tracks.map((track, i) => {
      const trackArtists = (track.artists || []).map(a => escapeHtml(a.name)).join(', ');
      return `<div class="track-row">
        <span class="track-num">${i + 1}</span>
        <div class="track-info">
          <span class="track-name">${escapeHtml(track.name)}</span>
          <span class="track-artist">${trackArtists}</span>
        </div>
      </div>`;
    }).join('\n');

    // Mood tags
    const moodTags = (analysis.moods || []).map((m, i) =>
      `<span class="mood-tag" style="animation-delay:${i * 0.15}s">${escapeHtml(m)}</span>`
    ).join('\n');

    // Cluster tags
    const clusterTags = (analysis.genreClusters || []).map((c, i) =>
      `<span class="cluster-tag" style="animation-delay:${i * 0.1}s">${escapeHtml(c)}</span>`
    ).join('\n');

    return `
    <div class="term-section" data-term="${t}" style="${termIdx === 0 ? "" : "display:none;"}">
      <h2 class="section-title"><span class="icon">${icon}</span> ${escapeHtml(label)}</h2>

      <section class="section">
        <h3 class="section-title"><span class="icon">🎤</span> Top Artists</h3>
        <div class="artist-grid">${artistCards || '<p style="color:#8b949e">No data available for this period.</p>'}</div>
      </section>

      <section class="section">
        <h3 class="section-title"><span class="icon">🎵</span> Top Tracks</h3>
        <div class="tracks-list">${trackRows || '<p style="color:#8b949e">No data available for this period.</p>'}</div>
      </section>

      <section class="section">
        <h3 class="section-title"><span class="icon">🌐</span> Genre Clusters</h3>
        <div class="cluster-cloud">${clusterTags}</div>
        <div class="genre-bars" style="margin-top:20px">${genreBars}</div>
      </section>

      <section class="section">
        <h3 class="section-title"><span class="icon">🌊</span> Mood & Texture</h3>
        <div class="mood-cloud">${moodTags}</div>
      </section>
    </div>`;
  }).join('\n');

  const shortArtists = new Set(((termResults.short_term && termResults.short_term.artists) || []).map(artist => artist.name).filter(Boolean));
  const medArtists = new Set(((termResults.medium_term && termResults.medium_term.artists) || []).map(artist => artist.name).filter(Boolean));
  const longArtists = new Set(((termResults.long_term && termResults.long_term.artists) || []).map(artist => artist.name).filter(Boolean));
  const consistentFavs = [...shortArtists].filter(name => medArtists.has(name) && longArtists.has(name));
  const newDiscoveries = [...shortArtists].filter(name => !longArtists.has(name));
  const shortTrackIds = new Set(((termResults.short_term && termResults.short_term.tracks) || []).map(track => track.id).filter(Boolean));
  const longTrackIds = new Set(((termResults.long_term && termResults.long_term.tracks) || []).map(track => track.id).filter(Boolean));
  const trackOverlap = [...shortTrackIds].filter(id => longTrackIds.has(id)).length;

  const evolutionSection = `
    <section class="section" style="animation-delay:0.35s">
      <h2 class="section-title"><span class="icon">📈</span> Listening Evolution</h2>
      <div class="evo-grid">
        <div class="evo-card">
          <div class="evo-num">${consistentFavs.length}</div>
          <div class="evo-label">Consistent Favorites</div>
          <div class="evo-detail">${escapeHtml(consistentFavs.join(', ') || 'No artists in all three periods yet.')}</div>
        </div>
        <div class="evo-card">
          <div class="evo-num">${newDiscoveries.length}</div>
          <div class="evo-label">New Discoveries</div>
          <div class="evo-detail">${escapeHtml(newDiscoveries.join(', ') || 'No short-term discoveries compared with all time.')}</div>
        </div>
        <div class="evo-card">
          <div class="evo-num">${trackOverlap}</div>
          <div class="evo-label">Track Overlap</div>
          <div class="evo-detail">Tracks shared between your short-term and all-time top lists.</div>
        </div>
      </div>
    </section>`;

  const allGenresForDiversity = [];
  for (const t of allTerms) {
    if (termResults[t] && termResults[t].analysis) {
      allGenresForDiversity.push(...((termResults[t].analysis.genres || []).filter(Boolean)));
    }
  }
  const genreCounts = allGenresForDiversity.reduce((acc, genre) => {
    acc[genre] = (acc[genre] || 0) + 1;
    return acc;
  }, {});
  const uniqueGenreCount = Object.keys(genreCounts).length;
  const totalGenreCount = allGenresForDiversity.length;
  const entropy = totalGenreCount
    ? Object.values(genreCounts).reduce((sum, count) => {
        const p = count / totalGenreCount;
        return sum - (p * Math.log2(p));
      }, 0)
    : 0;
  const maxEntropy = uniqueGenreCount > 1 ? Math.log2(uniqueGenreCount) : 0;
  const diversityScore = maxEntropy > 0 ? Math.round((entropy / maxEntropy) * 100) : 0;
  const diversityLabel = diversityScore > 70 ? 'Eclectic Explorer' : (diversityScore >= 40 ? 'Focused Listener' : 'Genre Loyalist');
  const diversityColor = diversityScore > 70 ? '#64ffda' : (diversityScore >= 40 ? '#ffd740' : '#1DB954');
  const diversityDescription = uniqueGenreCount
    ? `Across ${uniqueGenreCount} unique genres, your listening pattern maps as ${diversityLabel.toLowerCase()}.`
    : 'No genre data was available to calculate a diversity score.';
  const diversitySection = `
    <section class="section" style="animation-delay:0.4s">
      <h2 class="section-title"><span class="icon">🧭</span> Genre Diversity</h2>
      <div class="diversity-wrap">
        <div class="diversity-circle" style="border-color:${diversityColor}">
          <div class="diversity-score">${diversityScore}</div>
        </div>
        <div>
          <div class="diversity-label" style="color:${diversityColor}">${escapeHtml(diversityLabel)}</div>
          <div class="diversity-desc">${escapeHtml(diversityDescription)}</div>
        </div>
      </div>
    </section>`;

  // Recently Played section (optional) — uses combined data from all terms
  let recentSection = '';
  if (recentPlayed && recentPlayed.items && recentPlayed.items.length) {
    const items = recentPlayed.items.slice(0, 10);
    // Combine track IDs and artist names from all terms for matching
    const allTrackIds = new Set();
    const allArtistNames = new Set();
    for (const t of allTerms) {
      if (termResults[t]) {
        (termResults[t].tracks || []).forEach(tr => { if (tr.id) allTrackIds.add(tr.id); });
        (termResults[t].artists || []).forEach(a => { if (a.name) allArtistNames.add(a.name); });
      }
    }
    let matches = 0;
    const recentRows = items.map((it, idx) => {
      const track = it.track || {};
      const artists = (track.artists || []).map(a => escapeHtml(a.name)).join(', ');
      const playedAt = it.played_at ? new Date(it.played_at).toLocaleString() : '';
      if (track.id && allTrackIds.has(track.id)) matches += 1;
      else if ((track.artists || []).some(a => allArtistNames.has(a.name))) matches += 1;
      return `<div class="track-row">
        <span class="track-num">${idx + 1}</span>
        <div class="track-info">
          <span class="track-name">${escapeHtml(track.name || '(unknown)')}</span>
          <span class="track-artist">${artists}${playedAt ? ` <span class="played-at">· ${escapeHtml(playedAt)}</span>` : ''}</span>
        </div>
      </div>`;
    }).join('\n');
    const total = items.length || 1;
    const pct = Math.round((matches / total) * 100);
    let interpretation = '';
    if (pct >= 60) interpretation = 'Your recent listens are largely within your established top rotation.';
    else if (pct >= 25) interpretation = 'Some overlap — you are sampling outside your top rotation occasionally.';
    else interpretation = 'Recent drift detected — your recent plays diverge from your longer-term top artists/tracks.';
    recentSection = `
    <section class="section">
      <h2 class="section-title"><span class="icon">🔄</span> Recently Played</h2>
      <div class="drift-badge">
        <div class="drift-pct">${pct}%</div>
        <div class="drift-label">rotation match</div>
      </div>
      <p class="drift-interp">${escapeHtml(interpretation)}</p>
      <div class="tracks-list">${recentRows}</div>
    </section>`;
  }

  let heatmapSection = '';
  if (recentPlayed && recentPlayed.items && recentPlayed.items.length) {
    const hourCounts = Array(24).fill(0);
    recentPlayed.items.forEach((item) => {
      if (!item || !item.played_at) return;
      const playedAt = new Date(item.played_at);
      if (Number.isNaN(playedAt.getTime())) return;
      hourCounts[playedAt.getUTCHours()] += 1;
    });
    const maxCount = Math.max(...hourCounts, 0);
    const heatmapBars = hourCounts.map((count, hour) => {
      const height = maxCount > 0 ? Math.max(4, Math.round((count / maxCount) * 80)) : 4;
      return `<div class="heatmap-bar-wrap">
        <div class="heatmap-count">${count}</div>
        <div class="heatmap-bar" style="height:${height}px"></div>
        <div class="heatmap-hour">${hour}</div>
      </div>`;
    }).join('\n');
    heatmapSection = `
    <section class="section">
      <h2 class="section-title"><span class="icon">🕒</span> When You Listen</h2>
      <div class="heatmap-container">${heatmapBars}</div>
    </section>`;
  }

  // Saved Library section (optional)
  let librarySection = '';
  if (savedLibrary) {
    const snapshotRows = (savedLibrary.snapshot || []).map((line, i) =>
      `<div class="track-row"><span class="track-num">${i + 1}</span><div class="track-info"><span class="track-name">${escapeHtml(line.replace(/^\d+\.\s*/, ''))}</span></div></div>`
    ).join('\n');
    librarySection = `
    <section class="section">
      <h2 class="section-title"><span class="icon">💾</span> Saved Library Snapshot</h2>
      <div class="tracks-list">${snapshotRows}</div>
      <div class="library-signature">${escapeHtml(savedLibrary.signature)}</div>
      <div class="library-comparison">${escapeHtml(savedLibrary.comparison)}</div>
    </section>`;
  }

  // Taste Summary section — based on all 3 terms combined
  let tasteSummarySection = '';
  {
    // Merge analysis data from all terms
    const allClusters = [];
    const allMoods = [];
    const allGenres = [];
    for (const t of allTerms) {
      if (termResults[t] && termResults[t].analysis) {
        allClusters.push(...(termResults[t].analysis.genreClusters || []));
        allMoods.push(...(termResults[t].analysis.moods || []));
        allGenres.push(...(termResults[t].analysis.genres || []));
      }
    }
    const uniqueClusters = [...new Set(allClusters)];
    const uniqueMoods = [...new Set(allMoods)];
    const uniqueGenres = [...new Set(allGenres)];

    const clusterText = uniqueClusters.length ? uniqueClusters.slice(0, 5).join(', ') : 'a diverse mix';
    const moodText = uniqueMoods.length ? uniqueMoods.slice(0, 4).join(', ') : 'varied';
    const genreText = uniqueGenres.slice(0, 5).join(', ') || 'eclectic';

    let summaryParagraph = `Your listening gravitates toward <strong>${escapeHtml(clusterText)}</strong>, `;
    summaryParagraph += `with a sonic palette that feels <strong>${escapeHtml(moodText)}</strong>. `;
    summaryParagraph += `The genre fingerprint centers on ${escapeHtml(genreText)}`;

    // Compare short_term vs long_term for evolution insight
    const shortArtists = termResults.short_term ? (termResults.short_term.artists || []) : [];
    const longArtists = termResults.long_term ? (termResults.long_term.artists || []) : [];
    if (shortArtists.length && longArtists.length) {
      const shortNames = new Set(shortArtists.map(a => a.name));
      const longNames = new Set(longArtists.map(a => a.name));
      const newInRotation = [...shortNames].filter(n => !longNames.has(n));
      if (newInRotation.length > 0) {
        summaryParagraph += `. Recent additions to your rotation include <strong>${escapeHtml(newInRotation.slice(0, 3).join(', '))}</strong>`;
        summaryParagraph += `, suggesting a taste that keeps evolving while staying rooted`;
      } else {
        summaryParagraph += `. Your current rotation closely mirrors your all-time favorites — a listener who knows what they love`;
      }
    }
    summaryParagraph += '.';
    tasteSummarySection = `
    <section class="section" style="animation-delay:0.5s">
      <h2 class="section-title"><span class="icon">📝</span> Taste Summary</h2>
      <div class="taste-summary">${summaryParagraph}</div>
    </section>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${displayName}'s Spotify Taste Profile</title>
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
@keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
@keyframes pulse{0%,100%{opacity:0.7}50%{opacity:1}}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh;line-height:1.6;-webkit-font-smoothing:antialiased}
.container{max-width:900px;margin:0 auto;padding:24px 20px 60px}
.hero{text-align:center;padding:60px 20px 50px;background:linear-gradient(135deg,#161b22 0%,#0d1117 50%,#1a1f2b 100%);border-radius:24px;margin-bottom:40px;position:relative;overflow:hidden;animation:fadeUp 0.8s ease}
.hero::before{content:'';position:absolute;top:0;left:0;right:0;bottom:0;background:radial-gradient(ellipse at 30% 20%,rgba(29,185,84,0.08) 0%,transparent 60%),radial-gradient(ellipse at 70% 80%,rgba(29,185,84,0.05) 0%,transparent 50%);pointer-events:none}
.hero-avatar{width:120px;height:120px;border-radius:50%;border:3px solid #1DB954;margin:0 auto 20px;object-fit:cover;box-shadow:0 0 40px rgba(29,185,84,0.3)}
.hero-avatar-placeholder{width:120px;height:120px;border-radius:50%;border:3px solid #1DB954;margin:0 auto 20px;background:linear-gradient(135deg,#1DB954,#191414);display:flex;align-items:center;justify-content:center;font-size:48px;font-weight:700;color:#fff;box-shadow:0 0 40px rgba(29,185,84,0.3)}
.hero-name{font-size:2.2rem;font-weight:800;background:linear-gradient(135deg,#1DB954,#64ffda);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:8px}
.hero-subtitle{color:#8b949e;font-size:1rem;font-weight:400}
.section{animation:fadeUp 0.6s ease both;margin-bottom:40px}
.section-title{font-size:1.3rem;font-weight:700;margin-bottom:16px;display:flex;align-items:center;gap:10px;color:#e6edf3}
.icon{font-size:1.3rem}
.term-section{animation:fadeUp 0.6s ease both;margin-bottom:20px;padding:20px 0}
.term-section:last-of-type{border-bottom:none}
.term-heading{font-size:1.8rem;font-weight:800;margin-bottom:28px;display:flex;align-items:center;gap:12px;color:#f0f6fc;padding-bottom:12px;border-bottom:2px solid #1DB954}
.tab-container{margin-bottom:40px}
.tab-bar{display:flex;gap:0;margin-bottom:30px;border-bottom:2px solid #21262d;overflow-x:auto;-webkit-overflow-scrolling:touch}
.tab-btn{background:none;border:none;color:#8b949e;font-size:1rem;font-weight:600;padding:14px 24px;cursor:pointer;border-bottom:3px solid transparent;transition:color 0.2s,border-color 0.2s;white-space:nowrap;font-family:inherit}
.tab-btn:hover{color:#e6edf3}
.tab-btn.active{color:#1DB954;border-bottom-color:#1DB954}
.tab-panels{position:relative}
.artist-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px}
.artist-card{background:linear-gradient(145deg,#161b22,#1c2333);border:1px solid #21262d;border-radius:16px;padding:16px;display:flex;gap:14px;align-items:center;transition:transform 0.2s,box-shadow 0.2s,border-color 0.2s}
.artist-card:hover{transform:translateY(-3px);box-shadow:0 8px 30px rgba(29,185,84,0.1);border-color:#1DB954}
.artist-img{width:56px;height:56px;border-radius:12px;object-fit:cover;flex-shrink:0}
.artist-img-placeholder{background:linear-gradient(135deg,#1DB954,#161b22);display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;color:#fff}
.artist-name{font-weight:600;font-size:1rem;margin-bottom:6px;color:#f0f6fc}
.artist-genres{display:flex;flex-wrap:wrap;gap:4px}
.pill{display:inline-block;padding:2px 10px;border-radius:20px;font-size:0.7rem;font-weight:600;color:#0d1117;white-space:nowrap}
.pill-muted{background:#30363d;color:#8b949e}
.tracks-list{display:flex;flex-direction:column;gap:6px}
.track-row{display:flex;align-items:center;gap:14px;padding:10px 14px;background:#161b22;border-radius:10px;border:1px solid transparent;transition:border-color 0.2s,background 0.2s}
.track-row:hover{border-color:#21262d;background:#1c2333}
.track-num{color:#1DB954;font-weight:700;font-size:0.9rem;min-width:24px;text-align:right}
.track-info{display:flex;flex-direction:column;gap:2px;min-width:0}
.track-name{font-weight:600;font-size:0.95rem;color:#f0f6fc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.track-artist{color:#8b949e;font-size:0.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.played-at{color:#484f58;font-size:0.75rem}
.genre-bars{display:flex;flex-direction:column;gap:10px;max-width:600px}
.genre-bar{display:flex;align-items:center;gap:12px}
.genre-label{color:#8b949e;font-size:0.85rem;min-width:140px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.genre-bar-track{flex:1;height:24px;background:#161b22;border-radius:12px;overflow:hidden}
.genre-bar-fill{height:100%;border-radius:12px;background:linear-gradient(90deg,#1DB954,#64ffda);transition:width 1s ease}
.mood-cloud{display:flex;flex-wrap:wrap;gap:12px;justify-content:center;padding:20px 0}
.mood-tag{display:inline-block;padding:8px 20px;border-radius:30px;font-size:0.9rem;font-weight:500;color:#e6edf3;background:linear-gradient(135deg,rgba(29,185,84,0.15),rgba(100,255,218,0.1));border:1px solid rgba(29,185,84,0.2);animation:float 3s ease infinite;white-space:nowrap}
.cluster-cloud{display:flex;flex-wrap:wrap;gap:10px;padding:10px 0}
.cluster-tag{display:inline-block;padding:10px 22px;border-radius:14px;font-size:0.95rem;font-weight:600;color:#f0f6fc;background:linear-gradient(135deg,#1c2333,#21262d);border:1px solid #30363d;animation:fadeUp 0.5s ease both}
.taste-summary{color:#c9d1d9;font-size:0.95rem;line-height:1.7;padding:20px;background:linear-gradient(145deg,#161b22,#1a1f2b);border:1px solid #21262d;border-radius:16px}
.drift-badge{display:inline-flex;flex-direction:column;align-items:center;background:linear-gradient(135deg,rgba(29,185,84,0.15),rgba(100,255,218,0.08));border:1px solid rgba(29,185,84,0.25);border-radius:16px;padding:16px 28px;margin-bottom:12px}
.drift-pct{font-size:2rem;font-weight:800;color:#1DB954}
.drift-label{font-size:0.8rem;color:#8b949e;margin-top:2px}
.drift-interp{color:#8b949e;font-size:0.9rem;margin-bottom:16px}
.library-signature{color:#8b949e;font-size:0.9rem;margin-top:16px;padding:14px;background:#161b22;border-radius:10px;border-left:3px solid #1DB954}
.library-comparison{color:#8b949e;font-size:0.85rem;margin-top:10px;padding:10px 14px;background:#161b22;border-radius:10px}
.evo-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}
.evo-card{background:linear-gradient(145deg,#161b22,#1a1f2b);border:1px solid #21262d;border-radius:16px;padding:22px 18px;text-align:center}
.evo-num{font-size:2rem;font-weight:800;color:#1DB954;line-height:1}
.evo-label{color:#f0f6fc;font-size:0.95rem;font-weight:700;margin-top:10px}
.evo-detail{color:#8b949e;font-size:0.82rem;line-height:1.6;margin-top:10px}
.diversity-wrap{display:flex;align-items:center;gap:30px;padding:8px 0}
.diversity-circle{width:120px;height:120px;border-radius:50%;border:4px solid #1DB954;display:flex;align-items:center;justify-content:center;background:linear-gradient(145deg,#161b22,#1a1f2b);flex-shrink:0}
.diversity-score{font-size:2rem;font-weight:800;color:#f0f6fc}
.diversity-label{font-size:1.2rem;font-weight:700}
.diversity-desc{color:#8b949e;font-size:0.9rem;line-height:1.7;max-width:420px}
.heatmap-container{display:flex;align-items:flex-end;gap:4px;height:100px;padding:10px 0}
.heatmap-bar-wrap{display:flex;flex-direction:column;align-items:center;flex:1;gap:4px}
.heatmap-bar{width:100%;min-width:8px;border-radius:4px 4px 0 0;background:linear-gradient(to top,#1DB954,#64ffda);transition:height 0.5s ease}
.heatmap-hour{font-size:0.6rem;color:#484f58}
.heatmap-count{font-size:0.55rem;color:#8b949e}
.share-btn{margin-top:16px;padding:10px 28px;background:#1DB954;color:#0d1117;border:none;border-radius:30px;font-size:0.9rem;font-weight:700;cursor:pointer;transition:background 0.2s,transform 0.2s;font-family:inherit}
.share-btn:hover{background:#1ed760;transform:translateY(-2px)}
.share-btn:disabled{opacity:0.6;cursor:not-allowed;transform:none}
.footer{text-align:center;padding:40px 20px 20px;color:#484f58;font-size:0.8rem}
.footer a{color:#1DB954;text-decoration:none}
.watermark{color:#30363d;font-size:0.7rem;margin-top:8px}
@media(max-width:640px){
  .container{padding:16px 12px 40px}
  .hero{padding:40px 16px 36px;border-radius:16px}
  .hero-name{font-size:1.6rem}
  .artist-grid{grid-template-columns:1fr}
  .genre-label{min-width:100px;font-size:0.78rem}
  .mood-cloud{gap:8px}
  .mood-tag{padding:6px 14px;font-size:0.8rem}
  .term-heading{font-size:1.4rem}
}
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
</head>
<body>
<div class="container">

  <div class="hero">
    ${profileImage
      ? `<img src="${escapeHtml(profileImage)}" alt="${displayName}" class="hero-avatar" />`
      : `<div class="hero-avatar-placeholder">${escapeHtml(displayName.charAt(0).toUpperCase())}</div>`}
    <div class="hero-name">${displayName}</div>
    <div class="hero-subtitle">Spotify Taste Profile · All Time Ranges</div>
    <button class="share-btn" onclick="captureAndDownload()">Download as Image</button>
  </div>

  <div class="tab-container">
    <div class="tab-bar">
      <button class="tab-btn active" data-term="short_term">🕐 Last 4 Weeks</button>
      <button class="tab-btn" data-term="medium_term">📅 Last 6 Months</button>
      <button class="tab-btn" data-term="long_term">⭐ All Time</button>
    </div>
    <div class="tab-panels">
      ${termSectionsHtml}
    </div>
  </div>

  ${evolutionSection}

  ${diversitySection}

  ${tasteSummarySection}

  ${recentSection}

  ${heatmapSection}

  ${librarySection}

  <div class="footer">
    <div>Generated on ${escapeHtml(generatedAt)}</div>
    <div class="watermark">Generated by spotify-taste-analyzer</div>
  </div>

</div>
<script>
function captureAndDownload() {
  const btn = document.querySelector('.share-btn');
  btn.textContent = 'Generating...';
  btn.disabled = true;
  html2canvas(document.querySelector('.container'), {
    backgroundColor: '#0d1117',
    scale: 2,
    useCORS: true,
    logging: false
  }).then(canvas => {
    const link = document.createElement('a');
    link.download = 'spotify-taste-profile.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
    btn.textContent = 'Download as Image';
    btn.disabled = false;
  }).catch(() => {
    btn.textContent = 'Download as Image';
    btn.disabled = false;
  });
}
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const term = btn.dataset.term;
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".term-section").forEach(s => {
      s.style.display = s.dataset.term === term ? "" : "none";
    });
  });
});
</script>
</body>
</html>`;
}

async function runAnalyzeMe(options) {
  const term = options.term || 'medium_term';
  const limit = Math.max(1, Math.min(50, Number.parseInt(options.limit || '10', 10) || 10));
  if (!['short_term', 'medium_term', 'long_term'].includes(term)) throw new Error('Invalid --term. Use short_term, medium_term, or long_term.');
  const withFull = Boolean(options.full);
  const withHtml = Boolean(options.html);
  const withRecent = Boolean(options.withRecent || withFull || withHtml);
  const withLibrary = Boolean(options.withLibrary || withFull || withHtml);
  const tokens = await getValidTokens();
  const allTerms = ['short_term', 'medium_term', 'long_term'];
  const termLabels = { short_term: 'Last 4 Weeks', medium_term: 'Last 6 Months', long_term: 'All Time' };
  const termEmojis = { short_term: '🕐', medium_term: '📅', long_term: '⭐' };
  const termResults = {};
  for (const t of allTerms) {
    const [artists, tracks] = await Promise.all([
      spotifyApiGet(`/me/top/artists?time_range=${t}&limit=${limit}`, tokens.access_token),
      spotifyApiGet(`/me/top/tracks?time_range=${t}&limit=${limit}`, tokens.access_token),
    ]);
    const analysis = analyzeListeningProfile(artists.items || [], tracks.items || []);
    termResults[t] = { artists: artists.items || [], tracks: tracks.items || [], analysis };
  }
  const userProfile = withHtml ? await spotifyApiGet('/me', tokens.access_token) : null;
  const topArtists = { items: termResults[term]?.artists || [] };
  const topTracks = { items: termResults[term]?.tracks || [] };
  let recentPlayed = null;
  if (withRecent) {
    try { recentPlayed = await spotifyApiGet(`/me/player/recently-played?limit=10`, tokens.access_token); } catch (err) { console.log('\nWarning: failed to fetch recently-played:', err.message); recentPlayed = null; }
  }
  let savedTracks = null;
  if (withLibrary) {
    try { savedTracks = await spotifyApiGet(`/me/tracks?limit=20`, tokens.access_token); } catch (err) { console.log('\nWarning: failed to fetch saved tracks / liked songs:', err.message); savedTracks = null; }
  }
  console.log(`Spotify top artists/tracks analysis across all terms, limit=${limit}\n`);
  for (const t of allTerms) {
    const r = termResults[t];
    console.log(`\n=== ${termEmojis[t]} ${termLabels[t]} ===`);
    console.log('Top artists:');
    console.log(summarizeTopItems(r.artists, (artist) => {
      let artistGenres = (artist.genres || []).slice(0, 3);
      if (!artistGenres.length) {
        const inferred = inferGenresAndMoods([artist.name]);
        artistGenres = inferred.genres.slice(0, 3);
      }
      const genres = artistGenres.length ? ` [${artistGenres.join(', ')}]` : '';
      return `${artist.name}${genres}`;
    }));
    console.log('');
    console.log('Top tracks:');
    console.log(summarizeTopItems(r.tracks, (track) => { const artists = (track.artists || []).map((a) => a.name).join(', '); return `${track.name} - ${artists}`; }));
    console.log('');
    console.log('Genre clusters:', r.analysis.genreClusters.join(', ') || 'unknown');
    console.log('Genres:', r.analysis.genres.join(', ') || 'unknown');
    console.log('Moods:', r.analysis.moods.join(', ') || 'unknown');
  }

  const librarySummary = (withLibrary && savedTracks && Array.isArray(savedTracks.items))
    ? summarizeSavedLibrary(savedTracks, topArtists.items || [], topTracks.items || [])
    : null;

  if (withLibrary && savedTracks && Array.isArray(savedTracks.items)) {
    console.log('\nSaved tracks snapshot (up to 10):');
    if (librarySummary.snapshot.length) console.log(librarySummary.snapshot.join('\n'));
    else console.log('No saved tracks were returned in the sample.');
    console.log('\nSaved-library signature:');
    console.log(librarySummary.signature);
    console.log('\nComparison vs top artists/tracks:');
    console.log(librarySummary.comparison);
  }

  if (withRecent && recentPlayed && Array.isArray(recentPlayed.items)) {
    const items = recentPlayed.items.slice(0, 10);
    console.log('\nRecently played (up to 10):');
    const topTrackIds = new Set((topTracks.items || []).map((t) => t.id));
    const topArtistNames = new Set((topArtists.items || []).map((a) => a.name));
    let matches = 0;
    items.forEach((it, idx) => {
      const track = it.track || {};
      const artists = (track.artists || []).map((a) => a.name).join(', ');
      const playedAt = it.played_at || '';
      console.log(`${idx + 1}. ${track.name || '(unknown)'} - ${artists}${playedAt ? ` (played ${playedAt})` : ''}`);
      if (track.id && topTrackIds.has(track.id)) matches += 1;
      else if ((track.artists || []).some((a) => topArtistNames.has(a.name))) matches += 1;
    });
    const total = items.length || 1;
    const pct = Math.round((matches / total) * 100);
    console.log(`\nCurrent rotation / recent drift: ${matches}/${total} recent plays match your top artists/tracks (${pct}%).`);
    if (pct >= 60) console.log('Interpretation: Your recent listens are largely within your established top rotation.');
    else if (pct >= 25) console.log('Interpretation: Some overlap — you are sampling outside your top rotation occasionally.');
    else console.log('Interpretation: Recent drift detected — your recent plays diverge from your longer-term top artists/tracks.');
  }

  if (withHtml) {
    const htmlContent = generateHtmlReport({
      user: userProfile || { display_name: 'Spotify Listener' },
      termResults,
      termLabels,
      termEmojis,
      recentPlayed: recentPlayed || null,
      savedLibrary: librarySummary,
      generatedAt: new Date().toISOString(),
    });
    const outputPath = path.join(__dirname, 'taste-report.html');
    fs.writeFileSync(outputPath, htmlContent, 'utf8');
    console.log(`\nHTML report saved to: ${outputPath}`);
    openBrowser(outputPath);
  }
}

async function runLegacyMode(raw) {
  if (isSpotifyProfile(raw)) {
    console.log('Input detected: Spotify profile URL.');
    console.log('\nNote: Public Spotify profile pages expose very limited metadata without the Spotify Web API or user login.');
    console.log('I cannot reliably extract a full artist list or private playlists from a profile page.');
    console.log('Please paste a comma-separated list of artists or tracks instead, or run again with a public playlist URL.');
    return;
  }

  if (isSpotifyPlaylist(raw)) {
    console.log('Input detected: Spotify playlist URL. Attempting lightweight fetch of public page metadata...\n');
    try {
      const res = await request(raw);
      if (res.statusCode >= 400) console.log(`Failed to fetch playlist page: HTTP ${res.statusCode}.\nFalling back to explanation.`);
      else {
        const meta = (res.body || '').match ? (function(html){
          const out = {};
          const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
          const ogDesc = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
          const titleTag = html.match(/<title>([^<]+)</i);
          if (ogTitle) out.title = ogTitle[1].trim(); if (ogDesc) out.description = ogDesc[1].trim(); else if (titleTag) out.title = titleTag[1].trim(); return out;
        })(res.body) : {};
        if (meta.title || meta.description) {
          console.log('Found public metadata:'); if (meta.title) console.log('  Title:', meta.title); if (meta.description) console.log('  Description:', meta.description);
          console.log('\nUse this metadata as a lightweight hint; for accurate track-level parsing use the Spotify Web API.');
          const hintText = `${meta.title || ''} ${meta.description || ''}`;
          const tokens = hintText.split(/[,|·\-–:]/).map((p) => p.trim()).filter(Boolean).slice(0, 12);
          const { genres, moods } = inferGenresAndMoods(tokens);
          console.log('\nInferred genres/moods from page hints:', genres.join(', ') || 'unknown', '/', moods.join(', ') || 'unknown');
          return;
        }
        console.log('No usable public metadata found on playlist page.');
      }
    } catch (err) { console.log('Error fetching playlist page (network or blocked):', err.message); }
    console.log('\nFallback: without page metadata I can still recommend by style.');
    console.log('If you can paste a few artists from the playlist (comma-separated), the recommendations will be better.');
    return;
  }

  const items = String(raw || '').split(',').map((p) => p.trim()).filter(Boolean);
  if (items.length === 0) throw new Error('No items parsed. Provide a comma-separated list of artists or tracks or a Spotify URL.');
  console.log('Parsed items:', items.join(', '));
  const { genres, moods } = inferGenresAndMoods(items);
  console.log('\nInferred genre clusters:', genres.length ? genres.join(', ') : 'unknown');
  console.log('Inferred mood/texture tags:', moods.length ? moods.join(', ') : 'unknown');
}

async function runLogout() { if (!fs.existsSync(TOKEN_FILE)) { console.log(`No token file found at ${TOKEN_FILE}`); return; } fs.unlinkSync(TOKEN_FILE); console.log(`Deleted ${TOKEN_FILE}`); }

async function main() {
  const argv = process.argv.slice(2);
  const { positional, options } = parseArgs(argv);
  const command = positional[0];
  if (!command || command === 'help' || command === '--help' || command === '-h') { printHelp(); return; }
  if (command === 'auth' || command === 'login') { await runAuth(options); return; }
  if (command === 'logout') { await runLogout(); return; }
  if (command === 'analyze-me') { await runAnalyzeMe(options); return; }
  await runLegacyMode(positional.join(' '));
}

main().catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
