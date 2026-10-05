# GlobalNewsTV streams

Serverless stream list for the Global News TV app. A GitHub Actions job runs every 30 minutes, asks the
free YouTube Data API v3 which channels in [`channels.json`](channels.json) are live, and publishes
[`docs/streams.json`](docs/streams.json) through GitHub Pages. The app downloads that one static file.

```
channels.json ──► Actions cron ──► YouTube Data API v3 ──► docs/streams.json ──► GitHub Pages ──► app
 (you edit)       (every 30 min)       (free quota)           (committed)          (static CDN)
```

## One-time setup

1. **Create a public GitHub repo** and push this folder as its root (not as a subfolder of the app repo).
   Public is recommended: Actions and Pages are free, and nothing in here is secret. The branch must be
   named `main` (the workflow's push trigger and Pages setting assume it):
   `git init -b main && git add . && git commit -m "Initial commit"`, then add the remote and push.
2. **Create a YouTube API key** in [Google Cloud Console](https://console.cloud.google.com/):
   create a project → *APIs & Services* → enable **YouTube Data API v3** → *Credentials* → *Create API key*.
   Under *API restrictions* limit the key to **YouTube Data API v3**. (Application restrictions can't be used:
   GitHub runners have no fixed IP.)
3. **Add the key as a secret**: repo → *Settings* → *Secrets and variables* → *Actions* → *New repository secret*,
   name `YOUTUBE_API_KEY`.
4. **Enable Pages**: repo → *Settings* → *Pages* → *Deploy from a branch* → `main` / `/docs`.
5. **Run the workflow once**: *Actions* → *Update streams* → *Run workflow*. When it finishes, the file is at
   `https://<your-user>.github.io/<repo>/streams.json`.

Never put the API key in the Android app or commit it. Anything in the APK can be extracted.

## Run locally

Requires Node 20+ and no dependencies.

```bash
npm test                                   # unit tests, no API key needed
YOUTUBE_API_KEY=... npm run dry-run        # real API calls, writes nothing
YOUTUBE_API_KEY=... npm run resolve        # writes docs/streams.json and .state/
```

## Adding or removing channels

Edit [`channels.json`](channels.json) and push; the workflow re-runs on its own. The `id` is the channel ID
(starts with `UC`), found at youtube.com → channel → *About* → *Share* → *Copy channel ID*.

| Field | Meaning |
|---|---|
| `id`, `name` | Channel ID and display name. |
| `country` | ISO 3166-1 alpha-2, or `INT` for international. |
| `language` | ISO 639-1. |
| `category` | Free text used by the app for filtering, e.g. `general`, `business`. |
| `searchFallback` | Optional, `true` to use `search.list` (100 units) when the live stream can't be found in the channel's recent uploads. Use sparingly; capped at 2 searches per run and 1 per channel per day. |

## Output format

```json
{
  "version": 1,
  "generatedAt": "2026-10-05T12:00:00.000Z",
  "streams": [
    {
      "videoId": "xDWQ3LkccY8",
      "channelId": "UCoMdktPbSTixAyNGwb-UYkQ",
      "title": "Watch Sky News",
      "description": "…",
      "channelTitle": "Sky News",
      "country": "GB", "language": "en", "category": "general",
      "thumbnails": { "default": { "url": "…" }, "medium": { "url": "…" }, "high": { "url": "…" } },
      "concurrentViewers": 12345,
      "startedAt": "2026-08-27T05:24:39Z",
      "regionRestriction": null
    }
  ]
}
```

`title`, `description`, `channelTitle`, `videoId` and `thumbnails` keep the same names as the old API, so the
app's existing model keeps working. `regionRestriction` is YouTube's `allowed`/`blocked` country list when set.

## How it saves quota

Default quota is 10,000 units/day. `search.list` costs 100 units, so it is avoided. Instead each run:

1. **Re-verifies** last run's live videos with `videos.list` (1 unit per 50 videos).
2. **Scans a channel's uploads** (`playlistItems.list`, 1 unit) only when needed: when it just lost its stream,
   when it has been idle for 3 hours, or when it is live but hasn't been re-scanned for 12 hours.

A typical run costs a handful of units; a full scan of every channel costs about 2 units per channel. Tune the
intervals in `DEFAULTS` in [`scripts/lib.mjs`](scripts/lib.mjs). Each run prints the units it used.

## Policy notes

- Only videos that are public, embeddable and **not Made for Kids** are published.
- The app must show them with the official YouTube player, with no overlays on it, and with no background or
  audio-only playback.
- Data is refreshed at least every 6 hours, well inside YouTube's 30-day limit on keeping API data.
- GitHub may disable scheduled workflows on a repo with no activity for 60 days. The job commits at least every
  6 hours, which should keep the repo active, but I haven't confirmed that bot commits count as activity. Check
  the *Actions* tab now and then, and if the schedule gets disabled, re-enable it there.
