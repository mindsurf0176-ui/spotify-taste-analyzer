# spotify-taste-analyzer

> Turn a few artists, a playlist link, or your own Spotify account into a fast, surprisingly readable taste profile.

**spotify-taste-analyzer** is a lightweight CLI for understanding music taste without building a whole dashboard. It works in two modes:

- **No-auth mode:** analyze pasted artists/tracks or get lightweight hints from a public Spotify playlist URL
- **Authenticated mode:** connect your Spotify account and generate a richer profile from your top artists, top tracks, recent listening, and liked songs

It is intentionally small, scriptable, and easy to run locally.

> Repo folder name stays `spotify-classical-bridge` for stability, but the user-facing project name is **spotify-taste-analyzer**.

## Why this is fun

Most Spotify tools either need full auth immediately or dump raw data without saying anything interesting. This one is built to be useful in a terminal:

- gives you a **taste summary**, not just a list
- works even when you **do not want to set up Spotify auth yet**
- surfaces **genre clusters**, **mood/texture descriptors**, and notable signals
- can compare your **top taste** with your **current rotation** and **saved library**
- keeps the original **classical bridge recommendations** as an optional flavor, instead of making that the whole product

## Features

### No-auth mode

Works with zero Spotify credentials.

- Analyze a pasted list of artists or tracks
- Accept a public Spotify playlist URL and extract lightweight metadata hints
- Explain why Spotify profile URLs are limited without API access
- Great for quick experiments, demos, and screenshots

### Authenticated Spotify mode

Works after a one-time local OAuth flow.

- Fetch your top artists and top tracks
- Generate inferred genre clusters
- Add mood / texture descriptors
- Produce a concise written taste summary
- Optionally include:
  - **recently played** analysis with a simple rotation/drift view
  - **saved tracks / liked songs** snapshot and comparison
- Supports `--full` for the richer all-in-one analysis path

## Quick start

### 1) Install / run locally

```bash
cd /Users/minseo/.openclaw/workspace/tools/spotify-classical-bridge
node index.js help
```

If you want the package-style command later:

```bash
npm link
spotify-taste-analyzer help
```

### 2) Try it without auth

Paste artists:

```bash
node index.js "Radiohead, Slowdive, Mogwai"
```

Analyze a public playlist URL:

```bash
node index.js "https://open.spotify.com/playlist/37i9dQZF1DX2sUQwD7tbmL"
```

Profile URL limitation path:

```bash
node index.js "https://open.spotify.com/user/xxxxx"
```

### 3) Unlock full account analysis (optional)

Create a Spotify app in the Spotify Developer Dashboard and export your credentials:

```bash
export SPOTIFY_CLIENT_ID="your_client_id"
export SPOTIFY_CLIENT_SECRET="your_client_secret"
export SPOTIFY_REDIRECT_URI="http://127.0.0.1:8765/callback"
```

Then authenticate:

```bash
node index.js auth
```

And analyze your account:

```bash
node index.js analyze-me --term medium_term --limit 10
```

For the richer version:

```bash
node index.js analyze-me --term medium_term --limit 10 --full
```

## No-auth vs authenticated mode

| Mode | Needs Spotify developer app? | What you get |
|---|---:|---|
| Pasted artists/tracks | No | Fast genre, mood, and recommendation-style taste read |
| Public playlist URL | No | Lightweight metadata-based hints |
| Spotify profile URL | No | Limitation explanation only |
| `analyze-me` | Yes | Real account-based analysis from Spotify data |
| `analyze-me --full` | Yes | Adds recent listening + liked songs/library snapshot |

### Use no-auth mode when...

- you want to try the tool in 10 seconds
- you are sharing a demo with someone else
- you do not want to create Spotify developer credentials yet
- you just want a quick taste read from a few names

### Use authenticated mode when...

- you want a profile based on **your actual Spotify history**
- you want **top artists + tracks**, not just inferred taste from pasted input
- you want **recent rotation drift** and **liked songs/library** context

## Spotify setup for authenticated mode

1. Go to the Spotify Developer Dashboard: <https://developer.spotify.com/dashboard>
2. Create an app
3. Copy the Client ID and Client Secret
4. Add a Redirect URI for this CLI
   - Recommended: `http://127.0.0.1:8765/callback`
5. Save the app settings

Environment variables used by the CLI:

- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_REDIRECT_URI` *(optional; defaults to `http://127.0.0.1:8765/callback`)*

### Requested Spotify scopes

- `user-top-read`
- `user-read-recently-played`
- `user-library-read`

If you authorized an older version of the CLI before the extra scopes were added, **re-run `node index.js auth`** so Spotify issues tokens with the updated permissions.

## Usage

```bash
node index.js help
node index.js auth
node index.js auth --no-open
node index.js auth --code <authorization_code>
node index.js analyze-me --term medium_term --limit 10
node index.js analyze-me --term medium_term --limit 10 --with-recent
node index.js analyze-me --term medium_term --limit 10 --with-library
node index.js analyze-me --term medium_term --limit 10 --full
node index.js "Radiohead, Slowdive, Mogwai"
node index.js "https://open.spotify.com/playlist/..."
```

## Example output

### Pasted artists

```text
Parsed items: Radiohead, Slowdive, Mogwai

Inferred genre clusters: alt rock, art rock, shoegaze, dream pop, post-rock, instrumental rock
Inferred mood/texture tags: brooding, introspective, textured, reverb-drenched, ethereal, cinematic, expansive

Recommended classical works and bridge explanations:
...
```

### Authenticated account analysis

```text
Top artists:
- Artist A
- Artist B
- Artist C

Representative genres: chamber pop, indie folk, baroque pop
Mood / texture: intimate, warm, lyrical, wistful

Taste summary:
You tend to favor articulate songwriting, soft-to-rich arrangements, and emotionally detailed music with a reflective center.

Recent rotation drift:
- 40% overlap with top artists
- More upbeat in recent plays than long-term tops
```

## What the tool prints

Depending on mode and flags, output can include:

- inferred genre clusters
- representative genres
- mood / texture descriptors
- notable artist/track signals
- concise taste summary
- optional classical bridge examples
- recently played / rotation drift section
- saved-library snapshot and comparison

## Commands and flags

### Commands

- `help` — show usage
- `auth` / `login` — start Spotify OAuth flow
- `logout` — delete the locally stored token file
- `analyze-me` — analyze your Spotify account with stored tokens

### Useful flags

- `--term <short_term|medium_term|long_term>`
- `--limit <1-50>`
- `--no-open`
- `--code <authorization_code>`
- `--with-recent`
- `--with-library`
- `--full` — enables both `--with-recent` and `--with-library`

## Verification performed locally

Verified in this workspace with safe local commands:

```bash
node index.js --help
node index.js "Radiohead, Slowdive, Mogwai"
node index.js "https://open.spotify.com/user/xxxxx"
node index.js auth
```

What was confirmed:

- help output renders correctly
- no-auth pasted-artist analysis still works
- profile URL fallback still explains limitations clearly
- auth fails safely and clearly when Spotify credentials are not set

## Limitations

- Public Spotify profile pages do not expose enough structured data for reliable full parsing without API access
- Playlist URL mode is intentionally lightweight in no-auth mode
- Live authenticated analysis depends on real Spotify credentials and user authorization

## Security / privacy notes

- Tokens are stored locally in `.spotify-tokens.json`
- Do **not** commit real credentials or token files
- This repo should keep secrets local and out of version control

## Why star it?

If you like small CLI tools that do one interesting thing well — especially ones that turn messy music taste into something readable — this is that kind of project.

## License

MIT
