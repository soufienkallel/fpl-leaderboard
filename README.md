# FPL League Leaderboard

A live-updating leaderboard for your FPL classic league, deployed free on Vercel.

- [`api/data.ts`](api/data.ts) — TypeScript serverless function (Vercel Node runtime) that fetches
  standings + a gameweek recap (top scorers, averages, closest rivals, captain analysis) straight
  from FPL's public API. No login needed, no cron job, no committed data file — it computes the
  JSON on every request and lets Vercel's CDN cache it for 60s (`Cache-Control: s-maxage=60,
  stale-while-revalidate=180`).
- [`index.html`](index.html) — the leaderboard UI, unchanged in behavior from the original
  GitHub Pages version, now calling `/api/data` instead of a static `data.json`.
- [`goto.html`](goto.html) — script-driven redirect helper so tapping a team opens the FPL web
  page instead of the app.



## Deploy to Vercel

1. Push this repo to GitHub (already done if you're reading this from there).
2. Go to https://vercel.com/new and import the repo.
3. No build settings needed — Vercel auto-detects `index.html`/`goto.html` as static files and
   `api/data.ts` as a serverless function. Click **Deploy**.
4. Visit the deployment URL — the leaderboard loads immediately, no setup step required.

### Local development

```bash
npm install
npm run dev
```

This uses `vercel dev`, which serves `index.html` and runs `api/data.ts` locally, matching
production behavior.

## Changing the league ID

Edit `LEAGUE_ID` at the top of [`api/data.ts`](api/data.ts) if you ever need to point it at a
different league.
