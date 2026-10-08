# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

bar540.com — a small, self-contained site for a family home bar: what's on the two kegerator taps, a live inventory ("The Cellar") of whiskey, wine, and beer, a photo slideshow, a neon OPEN sign, and house rules. There's no cocktail menu (the owner decided against one). Zero build step, no framework. Priorities (from the owner, Chris): low cost (free tiers), low complexity, incremental features. Writes are gated by Google sign-in against an email allowlist; admin UI is only shown to signed-in users who have switched on edit mode.

See `AGENTS.md` for the standing portability directive: keep core logic provider-neutral and treat Cloudflare as one deployment target, not the architectural center. `SESSION-HANDOFF.md` has the full history of infra decisions and gotchas (DNS/email migration, Secrets Store, barcode scanner).

## Commands

No `package.json` — everything runs through `npx`.

```bash
npx wrangler dev        # local dev server (binds D1/R2/secrets per wrangler.jsonc)
npx wrangler deploy     # deploy to Cloudflare (also runs automatically from GitHub on push to main)
npx wrangler d1 execute bar540 --command "SELECT * FROM bottles"   # query prod D1
npx wrangler d1 execute bar540 --local --command "..."             # query local D1
npx wrangler d1 migrations apply bar540 --local                     # apply new migrations/ files locally
npx wrangler d1 migrations apply bar540 --remote                    # ...and to prod, BEFORE pushing code that needs them
```

There are no tests and no lint config.

## Architecture

A single Cloudflare Worker (`worker.js`) fronts everything. Its `fetch` handler is a flat `if`-ladder router; anything that doesn't match an API/photo route falls through to `env.ASSETS.fetch(request)`, which serves the static files in `public/`.

- `worker.js` — the backend. Routes: `GET/POST /api/bottles`, `GET /api/bottles/search?q=`, `GET/PUT/PATCH/DELETE /api/bottles/:id`, `GET /api/taps`, `PUT /api/taps/:id`, `GET/POST /api/gallery`, `DELETE /api/gallery/:id`, `GET /api/kegs`, `DELETE /api/kegs/:id`, `GET/POST /api/sensors`, `GET /api/sensors/history?sensor=&days=`, `GET/PUT /api/status`, `POST /api/identify`, `POST /api/recommend`, `GET /photos/:key`, `GET /api/lookup?upc=`, `GET /api/session`, `POST /api/login`, `POST /api/logout`.
- `ai.js` — Claude helpers, plain `fetch` to the Messages API with a JSON-schema response (shared `askForJson`): label/name lookup for the Add-a-Bottle form (`identifyBottle`, behind `POST /api/identify`) and the AI bartender (`recommendPour`, behind `POST /api/recommend`: a mood in, one bottle or tap out; the Worker loads what's on hand from D1 and rejects a pick that isn't in it). Both are signed-in only, since each call costs money. Needs the `ANTHROPIC_API_KEY` Worker secret; `CLAUDE_MODEL` optionally overrides the model.
- `auth.js` — portable (Web Crypto only) Google ID-token verification and HMAC-signed session cookies.
- `public/index.html` — main site, one file with an inline `<script>` per section. The Cellar script owns `/api/session` and the header's admin bar (avatar, Edit switch, sign in/out) and announces `bar540:session` with `{ authed, editing }`; other sections show their edit controls only when both are true. Sections share data with `publish(name, data)` (fires `bar540:<name>` and keeps the latest in `BAR540[name]`, so a script lower on the page can catch up).
- **Edit mode**: signed in, editing controls (gallery +/trash, Change keg, temp update, bottle stepper/edit/delete, Add a Bottle, sign switch, keg-log delete) stay hidden until the header's Edit switch is on. It's per tab (`sessionStorage` `bar540.editing`) and switches off after 10 idle minutes (`EDIT_IDLE_MS`). Purely cosmetic, like before: the server checks the session on every write.
- Cellar extras: "Pour me something" spins through the bottles in the current filter and lands on one; signed in, an "ask the bartender" box calls `/api/recommend`. "By the Numbers" (before House Rules) is computed client-side from the bottles and `/api/kegs`.
- **Seasons**: a `<head>` script sets `data-season` on `<html>` by date from `BAR540_SEASONS` (St. Patrick's, Derby, July 4, Halloween, December holidays), which swaps the accent CSS variables, the hero tagline, and some drifting emoji. Preview with `?season=halloween`; `?season=none` turns it off.
- On Tap extras: under the tower, sparklines of the kegerator temp (30 days) and the current keg's level, a kick forecast on the tap card (straight-line fit of the current keg's level readings; needs 12h+ of readings), and "Past Pours" from `keg_history`.
- The logo is `public/img/logo.jpg` (it used to be base64 inside `index.html`).
- The "From the Counter" photos are a single polaroid slideshow under the hero tagline (auto-advancing; dots, desktop arrows, swipe; tap for full size), loaded from `/api/gallery` (D1 `gallery_photos`). Signed-in users get + and trash icons on the polaroid's corner (trash removes the photo showing). Uploads go to R2 like bottle photos; the four original photos are static files in `public/img/gallery/` (deleting their rows just hides them).
- `public/login.html` — "Sign in with Google" (Google Identity Services); POSTs the ID token to `/api/login`.
- `public/add.html` — Add-a-Bottle form (fields, photo; redirects to sign-in if no session) with a barcode scanner (html5-qrcode from jsDelivr) that calls `/api/lookup` to autofill. With `?id=N` it's the Edit form for that bottle (loads `GET /api/bottles/N`, saves with `PUT`); the Cellar's bottle dialog links there. Saving a name another bottle already has gets a 409: adding offers to add to that bottle instead, editing asks for a different name.
- `wrangler.jsonc` — bindings: `ASSETS` (static dir `./public`), `DB` (D1), `PHOTOS` (R2); var `GOOGLE_CLIENT_ID`. Secrets Store bindings `ALLOWED_EMAILS` and `SESSION_SECRET` (`auth.js`'s `readSecret` accepts either a Secrets Store binding or a plain env string).

Data flow: bottle metadata lives in **D1** (`bottles` table); photos go to the **R2** bucket `bar540-photos` and are served *through* the Worker at `/photos/<uuid>.<ext>` (the bucket is private, not public). `/api/lookup` proxies the UPCitemdb free trial server-side so no key or rate limit is exposed to the client.

### Conventions that bite

- **Auth is a session cookie** (`bar540_session`, HttpOnly, SameSite=Strict, 30 days). POST and DELETE check it server-side; hiding admin UI is cosmetic. Removing an email from `ALLOWED_EMAILS` revokes it on the next request; rotating `SESSION_SECRET` signs everyone out.
- **Local dev reads Secrets Store bindings from the *local* store, not `.dev.vars`.** Populate it with `npx wrangler secrets-store secret create d7e39048e9b14ecbac44deb7b163e132 --name session-secret --scopes workers` (likewise `allowed-emails`); add `--remote` only to change production.
- **POST uses `multipart/form-data`** (because of the photo upload), read via `request.formData()`. Deleting a bottle also deletes its R2 photo.
- **Neon sign** (`GET/PUT /api/status`, `settings` row `bar_status`): `PUT {"open": true|false}` takes a session or the `SENSOR_TOKEN` bearer, so a Shortcut/NFC tag/smart switch can flip it later. An open sign reads as closed `BAR_AUTO_CLOSE_HOURS` (6) after it was last switched on; switching on again restarts the clock. There's deliberately no fixed schedule.
- **Keg history is written by `PUT /api/taps/:id`**: when a pouring tap goes empty or gets a different beer (name compared ignoring case/spacing), the old keg is copied to `keg_history`. A keg level typed into that form is also recorded as a `tapN_level_pct` sensor reading, so the forecast works without a real sensor.
- **`POST /api/sensors` takes a session *or* `Authorization: Bearer <SENSOR_TOKEN>`** (a plain Worker secret, `npx wrangler secret put SENSOR_TOKEN`), since sensors can't do Google sign-in. Body is a flat JSON object of readings; only keys in `SENSORS` in `worker.js` are accepted, and `tapN_level_pct` also updates that tap's `level_pct`.
- **`bottles.quantity` can be 0** — a bottle that's known but not on hand (a finished bottle, or one of the starter catalog rows from migration 0004). `GET /api/bottles` returns only `quantity > 0`; the Add-a-Bottle type-ahead (`/api/bottles/search`) searches everything, and posting with `existing_id` adds to that row instead of inserting a duplicate.
- **`bottles.category` is constrained** to `'whiskey' | 'wine' | 'beer'` by a CHECK; inserts outside that set will fail.
- **Keep images out of `public/index.html`** as files under `public/img/`, not base64; it used to be 430 KB from one logo embedded twice.
