# spotify-taste-analyzer

A CLI that turns your Spotify listening data into a visual taste profile. Generates a single-file HTML report you can open in any browser — no server needed.

![Node.js](https://img.shields.io/badge/node-%3E%3D18-green) ![License](https://img.shields.io/badge/license-MIT-blue)

## What you get

- **Three time ranges** — Last 4 Weeks / Last 6 Months / All Time, shown in switchable tabs
- **Top artists & tracks** per period with genre tags
- **Genre clusters & mood descriptors** inferred from your listening
- **Listening Evolution** — which artists stuck around, which are new discoveries
- **Genre Diversity score** — Shannon entropy-based metric (are you an Eclectic Explorer or a Genre Loyalist?)
- **When You Listen** — 24-hour heatmap from your recent plays
- **Recently Played** with rotation drift analysis
- **Saved Library** snapshot & comparison
- **Download as Image** — one-click PNG export of your entire profile
- Dark theme, responsive, works on mobile

## Setup

```bash
git clone https://github.com/mindsurf0176-ui/spotify-taste-analyzer.git
cd spotify-taste-analyzer
```

You'll need a [Spotify Developer](https://developer.spotify.com/dashboard) app:

```bash
export SPOTIFY_CLIENT_ID="your_id"
export SPOTIFY_CLIENT_SECRET="your_secret"
```

Authenticate (opens browser for OAuth):

```bash
node index.js auth
```

## Usage

```bash
# Full analysis with HTML report
node index.js analyze-me --html

# Terminal-only output
node index.js analyze-me

# Adjust limit
node index.js analyze-me --html --limit 20

# Quick analysis from pasted artists (no auth needed)
node index.js "keshi, Deftones, King Gnu"
```

The `--html` flag generates `taste-report.html` and opens it in your browser. It automatically includes recent plays and library data.

## Flags

| Flag | What it does |
|------|-------------|
| `--html` | Generate HTML report + auto-open |
| `--term <value>` | `short_term`, `medium_term`, or `long_term` (default: `medium_term`) |
| `--limit <n>` | Number of top artists/tracks per period (1-50, default: 10) |
| `--full` | Include recent plays + saved library (auto-enabled with `--html`) |
| `--with-recent` | Include recently played tracks |
| `--with-library` | Include saved/liked songs |

## No-auth mode

Don't want to set up Spotify credentials? You can still paste artists or a playlist URL:

```bash
node index.js "Radiohead, Slowdive, tricot, Age Factory"
node index.js "https://open.spotify.com/playlist/37i9dQZF1DX2sUQwD7tbmL"
```

You'll get genre clusters and mood descriptors — just no personalized data.

## How genre detection works

Spotify's API sometimes returns empty genre arrays for artists. When that happens, the tool falls back to a built-in heuristic that maps artist names to genres. Coverage includes J-rock, K-indie, K-R&B, shoegaze, post-punk, math rock, and more. PRs to expand the mapping are welcome.

## Privacy

- Tokens are stored locally in `.spotify-tokens.json` (gitignored)
- No data is sent anywhere except Spotify's own API
- The HTML report is a local file — nothing is uploaded

## License

MIT
