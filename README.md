# Alliances on Cloudflare Pages

A turn-based map game on a 25 x 25 grid. Every player is a country with a random flag. Be the last country standing.
Stability, action points and reach are hidden from everyone else.

This version runs entirely on Cloudflare: the page is static, the game API is a Pages Function, and game state lives in a D1 database.
There is no server to keep running.

```
public/            static site (index.html, app.js, style.css, flags.v1.css, _headers, _routes.json)
functions/api/     one catch-all Pages Function for /api/*
src/engine.js      all game rules (pure functions)
src/api.js         the HTTP API and D1 access
schema.sql         two tables: lobbies and limits
wrangler.toml      Pages and D1 configuration
```

## Deploy (about 5 minutes, free plan is enough to start)

You need a Cloudflare account and Node.js 18 or newer.

```
npm install
npx wrangler login
npx wrangler d1 create alliances
```

Copy the `database_id` that the last command prints into `wrangler.toml`, then:

```
npm run db:remote       # creates the tables in your D1 database
npm run deploy          # creates the Pages project "alliances" and uploads the site
```

Wrangler prints your address, `https://alliances.pages.dev` (or a variant if the name is taken). Share that link. No other setup is needed.

### Deploying from GitHub instead

1. Push this folder to a repository.
2. In the Cloudflare dashboard go to Workers & Pages, Create, Pages, Connect to Git.
3. Build command: leave empty. Build output directory: `public`.
4. The D1 binding comes from `wrangler.toml` (variable name `DB`). Run `npm run db:remote` once from your computer to create the tables.

### Run it locally

```
npm run db:local
npm run dev
```

Then open the address Wrangler prints.

## How a game works

- Anyone can **create a lobby**. They get a 5-character **lobby code** to share and a 20-character **master code** that makes them the host. The master code cannot be recovered, so save it.
- Players enter the lobby code and press **Join**. Each gets a random country and a 15-character **player code**.
  Entering that code on any device returns the player to their country.
- The host (master code) starts the game, sees every hidden number in the Host tab, can issue a new code to a player who lost theirs, can download the game data and can reset the lobby.
- **Rules:** every country starts with 3 stability, 1 action point (AP) and a reach of 2.
  At 8:00 pm in the game's time zone each country still in play gets +1 AP. AP can be spent from 8:00 to 10:15 pm.
  Move (1 AP), sanction a country in reach to remove 1 stability (1 AP), send 1 AP of aid to a country in reach (1 AP), or extend reach by 1 (2 AP).
  A country at 0 stability collapses and its AP pass to whoever delivered the final sanction.
  Collapsed countries vote daily on who receives a bonus AP. The full rules are in the app under "How to play".

## Fog of war

The API only sends each browser what that player may see: every position, every move, final sanctions and collapses,
plus the player's own numbers and private events. Other players' numbers never reach the browser.
Codes are stored only as SHA-256 hashes.

## What it costs on the free plan

Cloudflare's free plan allows 100,000 Pages Functions requests per day and 5 million D1 row reads per day.
Static files (the page, scripts, flags) are free and unlimited, so only game requests count.

The page polls for updates, and it slows down whenever nothing can change:

| Situation | Poll interval |
| --- | --- |
| Lobby | 5 seconds |
| Game running, action window open (8:00 to 10:15 pm) | 3 seconds |
| Game running, window closed | 30 seconds |
| Game over | 60 seconds |
| Browser tab in the background | 3x slower, at least 30 seconds |

Rough daily load for 10 players with the page open all day: about 25,000 requests during the window plus about 25,000 outside it,
which fits in the free plan. Many more players or several simultaneous games will need the Workers Paid plan ($5 per month, 10 million requests).
Pressing Refresh checks for changes immediately.

## Limits and housekeeping

- 30 lobby creations per hour per address, 60 wrong codes per 10 minutes per address.
- Lobbies that have not been touched for 60 days are deleted when someone creates a new lobby.
- Simultaneous orders are safe. Each update is a compare-and-swap on the lobby's version, and a conflicting request retries automatically.
- Daily AP are applied the first time anyone opens the lobby after 8:00 pm, using the time stored on the server, so no scheduled job is needed.
- Security headers and a strict Content-Security-Policy are set in `public/_headers`.

## Upgrading later

If you want instant updates instead of polling, the next step is a Durable Object per lobby with WebSockets.
That needs a separate Worker deployed next to the Pages project, and it is not required for normal play.
