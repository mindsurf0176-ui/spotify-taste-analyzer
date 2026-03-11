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
  ];
  const counts = {};
  ([... (genres || []), ... (names || [])]).forEach((value) => {
    moodRules.forEach((rule) => {
      if (rule.re.test(String(value).toLowerCase())) rule.values.forEach((v) => incrementMap(counts, v));
    });
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map((e) => e[0]);
}

function recommendClassical(genres, moods) {
  const catalog = [
    { title: 'Samuel Barber - Adagio for Strings', reason: 'Sustained tension and slow harmonic release map cleanly onto post-rock and slow-building indie emotional arcs.', tags: ['melancholic', 'strings', 'slow-build'] },
    { title: 'Arvo Part - Fratres', reason: 'Tintinnabuli repetition and austere resonance work well as a bridge from minimalist rock, ambient, and meditative listening habits.', tags: ['minimal', 'meditative', 'ritualistic'] },
    { title: 'Claude Debussy - Nuages', reason: 'Blurred orchestral color and suspended motion connect naturally to shoegaze haze, dream pop softness, and atmospheric playlists.', tags: ['impressionist', 'atmospheric', 'floating'] },
    { title: 'Maurice Ravel - Daphnis et Chloe Suite No. 2', reason: 'Dense layering, luminous orchestration, and long crescendos translate well for listeners who like immersive, maximal textures.', tags: ['lush', 'orchestral', 'textured'] },
    { title: 'Henryk Gorecki - Symphony No. 3', reason: 'Its spare pacing and emotional gravity often land with listeners drawn to sorrowful indie, post-rock, and devotional slowness.', tags: ['sparse', 'emotional', 'patient'] },
    { title: 'Philip Glass - Metamorphosis Two', reason: 'Loop-like patterning and gradual change give electronic, ambient, and hypnotic rock listeners a familiar entry point.', tags: ['repetitive', 'hypnotic', 'minimal'] },
    { title: 'Sofia Gubaidulina - Offertorium', reason: 'Fragmented motifs and ritual intensity suit listeners who lean toward darker art-rock, experimental, or dramatic textures.', tags: ['dramatic', 'experimental', 'dark-edged'] },
  ];
  const picks = [];
  function addIfMatches(test, titlePattern) {
    if (!test) return;
    const found = catalog.find((item) => titlePattern.test(item.title));
    if (found && !picks.includes(found)) picks.push(found);
  }
  const joinedGenres = (genres || []).join(' ').toLowerCase();
  const joinedMoods = (moods || []).join(' ').toLowerCase();
  addIfMatches(/post-rock|instrumental rock|cinematic/.test(joinedGenres), /Barber|Part/);
  addIfMatches(/shoegaze|dream pop|ambient/.test(joinedGenres) || /diffuse|immersive/.test(joinedMoods), /Debussy|Ravel/);
  addIfMatches(/indie folk|singer-songwriter|melancholic/.test(joinedGenres + joinedMoods), /Gorecki|Barber/);
  addIfMatches(/electronica|idm|hypnotic/.test(joinedGenres + joinedMoods), /Glass/);
  addIfMatches(/experimental|metal|dark-edged/.test(joinedGenres + joinedMoods), /Gubaidulina|Part/);
  catalog.forEach((item) => { if (picks.length < 5 && !picks.includes(item)) picks.push(item); });
  return picks.slice(0, 5);
}

function explainBridge(item) {
  return `${item.title}\n  Why: ${item.reason}\n  Tags: ${item.tags.join(', ')}\n`;
}

function printHelp() {
  console.log(`\n${TOOL_NAME} - CLI account & playlist listener taste analyzer\n\nUsage:\n  node index.js help\n  node index.js auth\n  node index.js login\n  node index.js auth --no-open\n  node index.js auth --code <authorization_code>\n  node index.js analyze-me --term medium_term --limit 10 [--full] [--with-recent] [--with-library]\n  node index.js "Radiohead, Slowdive, Mogwai"\n  node index.js "https://open.spotify.com/playlist/..."\n  node index.js "https://open.spotify.com/user/..."\n\nCommands:\n  help          Show this help text\n  auth, login   Start Spotify OAuth authorization code flow for this CLI\n  logout        Delete the locally stored token file\n  analyze-me    Use stored OAuth tokens to analyze your Spotify top artists/tracks\n\nFlags:\n  --term <value>    Spotify time range: short_term, medium_term, long_term\n  --limit <value>   Result limit for top artists/tracks (1-50, default 10)\n  --no-open         Print auth URL without trying to open the browser\n  --code <value>    Exchange a pasted Spotify authorization code manually\n  --full            Shortcut for analyze-me: enable both --with-recent and --with-library
  --with-recent     When used with analyze-me, also fetch your recently-played tracks (up to 10) and include a short 'rotation/drift' section
  --with-library    When used with analyze-me, also sample your saved tracks / liked songs (up to 20) and add a saved-library snapshot + comparison\n\nEnvironment variables for real Spotify auth:\n  SPOTIFY_CLIENT_ID\n  SPOTIFY_CLIENT_SECRET\n  SPOTIFY_REDIRECT_URI   Optional, defaults to ${DEFAULT_REDIRECT_URI}\n\nToken storage:\n  ${TOKEN_FILE}\n  The tool will try to create/update this file with mode 600.\n\nNotes:\n  - Real Spotify credentials are required for auth and analyze-me.\n  - No-auth fallback modes still work without credentials: profile URL, playlist URL, pasted artists/tracks.\n  - IMPORTANT: This version requests additional Spotify scopes (user-read-recently-played, user-library-read). If you previously authorized the CLI, you MUST re-run \"node index.js auth\" (or login) to grant the new scopes and obtain refreshed tokens.\n`);
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
  const recommendations = recommendClassical(sortedGenres, moods);
  return { genreClusters: clusters.length ? clusters : sortedGenres.slice(0, 4), genres: sortedGenres.slice(0, 10), moods, recommendations };
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

async function runAnalyzeMe(options) {
  const term = options.term || 'medium_term';
  const limit = Math.max(1, Math.min(50, Number.parseInt(options.limit || '10', 10) || 10));
  if (!['short_term', 'medium_term', 'long_term'].includes(term)) throw new Error('Invalid --term. Use short_term, medium_term, or long_term.');
  const withFull = Boolean(options.full);
  const withRecent = Boolean(options.withRecent || withFull);
  const withLibrary = Boolean(options.withLibrary || withFull);
  const tokens = await getValidTokens();
  const [topArtists, topTracks] = await Promise.all([
    spotifyApiGet(`/me/top/artists?time_range=${term}&limit=${limit}`, tokens.access_token),
    spotifyApiGet(`/me/top/tracks?time_range=${term}&limit=${limit}`, tokens.access_token),
  ]);
  let recentPlayed = null;
  if (withRecent) {
    try { recentPlayed = await spotifyApiGet(`/me/player/recently-played?limit=10`, tokens.access_token); } catch (err) { console.log('\nWarning: failed to fetch recently-played:', err.message); recentPlayed = null; }
  }
  let savedTracks = null;
  if (withLibrary) {
    try { savedTracks = await spotifyApiGet(`/me/tracks?limit=20`, tokens.access_token); } catch (err) { console.log('\nWarning: failed to fetch saved tracks / liked songs:', err.message); savedTracks = null; }
  }
  const analysis = analyzeListeningProfile(topArtists.items || [], topTracks.items || []);
  console.log(`Spotify top artists/tracks analysis for term=${term}, limit=${limit}\n`);
  console.log('Top artists:');
  console.log(summarizeTopItems(topArtists.items || [], (artist) => { const genres = artist.genres && artist.genres.length ? ` [${artist.genres.slice(0, 3).join(', ')}]` : ''; return `${artist.name}${genres}`; }));
  console.log('');
  console.log('Top tracks:');
  console.log(summarizeTopItems(topTracks.items || [], (track) => { const artists = (track.artists || []).map((a) => a.name).join(', '); return `${track.name} - ${artists}`; }));
  console.log('');
  console.log('Genre clusters:', analysis.genreClusters.join(', ') || 'unknown');
  console.log('Representative genres:', analysis.genres.join(', ') || 'unknown');
  console.log('Mood / texture descriptors:', analysis.moods.join(', ') || 'unknown');
  console.log('\nRecommended classical works:');
  analysis.recommendations.forEach((item) => console.log(`\n${explainBridge(item)}`));

  if (withLibrary && savedTracks && Array.isArray(savedTracks.items)) {
    const librarySummary = summarizeSavedLibrary(savedTracks, topArtists.items || [], topTracks.items || []);
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
          const recs = recommendClassical(genres, moods);
          console.log('\nInferred genres/moods from page hints:', genres.join(', ') || 'unknown', '/', moods.join(', ') || 'unknown');
          console.log('\nRecommended classical works and why they map to this playlist:');
          recs.forEach((item) => console.log(`\n${explainBridge(item)}`));
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
  const recs = recommendClassical(genres, moods);
  console.log('\nRecommended classical works and bridge explanations:');
  recs.forEach((item) => console.log(`\n${explainBridge(item)}`));
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
