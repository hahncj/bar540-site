# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

bar540.com — a small, self-contained site for a family home bar: a drink menu, photo gallery, house rules, and a live inventory ("The Cellar") of whiskey, wine, and beer. Zero build step, no framework. Priorities (from the owner, Chris): low cost (free tiers), low complexity, incremental features. Writes are gated by Google sign-in against an email allowlist; admin UI is only shown to signed-in users.

See `AGENTS.md` for the standing portability directive: keep core logic provider-neutral and treat Cloudflare as one deployment target, not the architectural center. `SESSION-HANDOFF.md` has the full history of infra decisions and gotchas (DNS/email migration, Secrets Store, barcode scanner).

## Commands

No `package.json` — everything runs through `npx`.

```bash
npx wrangler dev        # local dev server (binds D1/R2/secrets per wrangler.jsonc)
npx wrangler deploy     # deploy to Cloudflare (also runs automatically from GitHub on push to main)
npx wrangler d1 execute bar540 --command "SELECT * FROM bottles"   # query prod D1
npx wrangler d1 execute bar540 --local --command "..."             # query local D1
```

There are no tests and no lint config.

## Architecture

A single Cloudflare Worker (`worker.js`) fronts everything. Its `fetch` handler is a flat `if`-ladder router; anything that doesn't match an API/photo route falls through to `env.ASSETS.fetch(request)`, which serves the static files in `public/`.

- `worker.js` — the backend. Routes: `GET/POST /api/bottles`, `DELETE /api/bottles/:id`, `GET /photos/:key`, `GET /api/lookup?upc=`, `GET /api/session`, `POST /api/login`, `POST /api/logout`.
- `auth.js` — portable (Web Crypto only) Google ID-token verification and HMAC-signed session cookies.
- `public/index.html` — main site. The Cellar section fetches `/api/bottles` and `/api/session`; the Add button and per-card delete buttons render only when signed in. Footer has the sign-in/out link.
- `public/login.html` — "Sign in with Google" (Google Identity Services); POSTs the ID token to `/api/login`.
- `public/add.html` — Add-a-Bottle form (fields, photo; redirects to sign-in if no session) with a barcode scanner (html5-qrcode from jsDelivr) that calls `/api/lookup` to autofill.
- `wrangler.jsonc` — bindings: `ASSETS` (static dir `./public`), `DB` (D1), `PHOTOS` (R2); var `GOOGLE_CLIENT_ID`. Secrets Store bindings `ALLOWED_EMAILS` and `SESSION_SECRET` (`auth.js`'s `readSecret` accepts either a Secrets Store binding or a plain env string).

Data flow: bottle metadata lives in **D1** (`bottles` table); photos go to the **R2** bucket `bar540-photos` and are served *through* the Worker at `/photos/<uuid>.<ext>` (the bucket is private, not public). `/api/lookup` proxies the UPCitemdb free trial server-side so no key or rate limit is exposed to the client.

### Conventions that bite

- **Auth is a session cookie** (`bar540_session`, HttpOnly, SameSite=Strict, 30 days). POST and DELETE check it server-side; hiding admin UI is cosmetic. Removing an email from `ALLOWED_EMAILS` revokes it on the next request; rotating `SESSION_SECRET` signs everyone out.
- **Local dev reads Secrets Store bindings from the *local* store, not `.dev.vars`.** Populate it with `npx wrangler secrets-store secret create d7e39048e9b14ecbac44deb7b163e132 --name session-secret --scopes workers` (likewise `allowed-emails`); add `--remote` only to change production.
- **POST uses `multipart/form-data`** (because of the photo upload), read via `request.formData()`. Deleting a bottle also deletes its R2 photo.
- **`bottles.category` is constrained** to `'whiskey' | 'wine' | 'beer'` by a CHECK; inserts outside that set will fail.
- **Don't Read `public/index.html` whole** if it's carrying base64-embedded images — it can be very large. Use Grep with context or targeted Edits.
