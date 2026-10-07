import {
  allowedEmails,
  clearSessionCookie,
  createSessionCookie,
  hasBearerToken,
  readSecret,
  readSession,
  verifyGoogleIdToken,
} from "./auth.js";
import { identifyBottle, IdentifyError } from "./ai.js";

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Label photos sent to the AI are resized in the browser first; this is a backstop (the API's own per-image limit is 5 MB).
const MAX_IDENTIFY_IMAGE_BYTES = 4 * 1024 * 1024;

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// UPCitemdb's free trial (barcode lookup and product search): ~100 requests a day per IP plus a short burst limit.
// This Worker shares its outbound IP with other sites, so the quota can run out before we've used it.
const UPC_LIMIT_MESSAGE = "The product lookup service's limit is used up — try again later.";

async function upcitemdb(path, params) {
  const u = new URL(`https://api.upcitemdb.com/prod/trial/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const resp = await fetch(u.toString());
  const data = await resp.json().catch(() => ({}));
  if (resp.status === 429 || data.code === "TOO_FAST" || data.code === "EXCEED_LIMIT") throw new Error(UPC_LIMIT_MESSAGE);
  if (!resp.ok) throw new Error("Lookup service unavailable");
  return data;
}

// Search results include look-alikes (merch, unrelated products), so keep images only from listings
// whose title has every distinctive word of the name and doesn't look like merchandise.
const NAME_FILLER = new Set(["the", "and", "of", "year", "years", "old", "yr", "yo"]);
const MERCH = /\b(sign|shirt|tee|hat|cap|hoodie|glass(es|ware)?|mug|poster|opener|koozie|coaster|decal|sticker|tin|bag|socks?|keychain)\b/i;
function stockImagesFor(name, items, max = 8) {
  const words = name.toLowerCase().split(/[^a-z0-9'éè]+/).filter((w) => w.length > 1 && !NAME_FILLER.has(w) && !/^\d+$/.test(w));
  const images = [];
  for (const item of items) {
    const title = (item.title || "").toLowerCase();
    if (!words.length || !words.every((w) => title.includes(w)) || MERCH.test(title)) continue;
    for (const img of item.images || []) {
      if (/^https?:\/\//i.test(img) && !images.includes(img)) images.push(img);
      if (images.length >= max) return images;
    }
  }
  return images;
}

// Type-ahead matching: every word of q must appear somewhere in `column` (any order).
// LIKE wildcards typed by the user are escaped. Returns { words, where, params } for a prepared statement.
function matchAllWords(q, column) {
  const words = (q || "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
  return {
    words,
    where: words.map(() => `${column} LIKE ? ESCAPE '\\'`).join(" AND "),
    params: words.map((w) => "%" + w.replace(/[\\%_]/g, (c) => "\\" + c) + "%"),
  };
}

// Readings the kegerator can report, with the range a sane value falls in.
// A tapN_level_pct reading also sets that tap's keg level.
const SENSORS = {
  fridge_temp_f: [-20, 120],
  tap1_level_pct: [0, 100],
  tap2_level_pct: [0, 100],
};
const SENSOR_HISTORY_DAYS = 90;

const MAX_STOCK_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_EXTS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

async function storePhoto(env, bytes, contentType, ext) {
  const key = `${crypto.randomUUID()}.${ext}`;
  await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType } });
  return `/photos/${key}`;
}

// Download a stock product image. Returns null unless it's a reasonably sized image over http(s).
async function fetchStockImage(rawUrl) {
  const src = new URL(rawUrl);
  if (src.protocol !== "https:" && src.protocol !== "http:") return null;
  const resp = await fetch(src.toString(), { redirect: "follow" });
  if (!resp.ok) return null;
  const contentType = (resp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = IMAGE_EXTS[contentType];
  if (!ext) return null;
  const bytes = await resp.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_STOCK_IMAGE_BYTES) return null;
  return { bytes, contentType, ext };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const secure = url.protocol === "https:";
    const allowed = allowedEmails(env.ALLOWED_EMAILS);
    const sessionSecret = await readSecret(env.SESSION_SECRET);
    const session = await readSession(request, sessionSecret, allowed);

    // --- Who am I? Also hands the page the (public) Google client ID ---
    if (url.pathname === "/api/session" && request.method === "GET") {
      return Response.json({
        authed: !!session,
        email: session?.email || null,
        name: session?.name || null,
        picture: session?.picture || null,
        googleClientId: env.GOOGLE_CLIENT_ID || null,
      });
    }

    // --- Sign in: exchange a Google ID token for a session cookie ---
    if (url.pathname === "/api/login" && request.method === "POST") {
      if (!env.GOOGLE_CLIENT_ID || !sessionSecret) return jsonError("Sign-in is not configured", 500);
      let body = {};
      try {
        body = await request.json();
      } catch (e) {}

      let claims;
      try {
        claims = await verifyGoogleIdToken(body.credential, env.GOOGLE_CLIENT_ID);
      } catch (e) {
        return jsonError("Google sign-in could not be verified", 401);
      }
      const email = String(claims.email).toLowerCase();
      if (!allowed.includes(email)) return jsonError(`${email} isn't on the admin list`, 403);

      const cookie = await createSessionCookie({ email, name: claims.given_name || claims.name, picture: claims.picture }, sessionSecret, secure);
      return Response.json({ ok: true, email }, { headers: { "set-cookie": cookie } });
    }

    // --- Sign out ---
    if (url.pathname === "/api/logout" && request.method === "POST") {
      return Response.json({ ok: true }, { headers: { "set-cookie": clearSessionCookie(secure) } });
    }

    // --- List bottles on hand (quantity 0 = known but not on hand; those only feed the type-ahead) ---
    if (url.pathname === "/api/bottles" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, category, name, maker, notes, abv, photo_url, added_at, purchased_on, vintage, quantity FROM bottles WHERE quantity > 0 ORDER BY category, name"
      ).all();
      return Response.json(results);
    }

    // --- Type-ahead for the Add-a-Bottle form: every bottle we know, on hand first ---
    if (url.pathname === "/api/bottles/search" && request.method === "GET") {
      if (!session) return jsonError("Sign in to search bottles", 401);
      const { words, where, params } = matchAllWords(url.searchParams.get("q"), "(name || ' ' || COALESCE(maker, ''))");
      if (!words.length) return Response.json([]);
      const { results } = await env.DB.prepare(
        `SELECT id, category, name, maker, notes, abv, photo_url, vintage, quantity FROM bottles WHERE ${where} ` +
        "ORDER BY quantity > 0 DESC, lower(name) LIKE ? ESCAPE '\\' DESC, name LIMIT 8"
      ).bind(...params, params[0].slice(1)).all();
      return Response.json(results);
    }

    // --- Type-ahead for the maker field: makers we know (optionally within a category), most bottles first ---
    if (url.pathname === "/api/makers" && request.method === "GET") {
      if (!session) return jsonError("Sign in to search makers", 401);
      const { words, where, params } = matchAllWords(url.searchParams.get("q"), "maker");
      if (!words.length) return Response.json([]);
      const category = url.searchParams.get("category");
      const byCategory = ["whiskey", "wine", "beer"].includes(category);
      const { results } = await env.DB.prepare(
        `SELECT maker, COUNT(*) AS bottles FROM bottles WHERE maker IS NOT NULL AND ${where}` +
        (byCategory ? " AND category = ?" : "") +
        " GROUP BY lower(maker) ORDER BY lower(maker) LIKE ? ESCAPE '\\' DESC, bottles DESC, maker LIMIT 8"
      ).bind(...params, ...(byCategory ? [category] : []), params[0].slice(1)).all();
      return Response.json(results);
    }

    // --- Add a bottle ---
    if (url.pathname === "/api/bottles" && request.method === "POST") {
      if (!session) return jsonError("Sign in to add bottles", 401);
      let form;
      try {
        form = await request.formData();
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid form submission" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      const category = form.get("category");
      const name = form.get("name");
      const maker = form.get("maker") || null;
      const notes = form.get("notes") || null;
      const abvRaw = form.get("abv");
      const abv = abvRaw ? Number(abvRaw) : null;
      const purchasedOn = form.get("purchased_on") || null;
      const vintageRaw = form.get("vintage");
      const vintage = vintageRaw && category === "wine" ? Number(vintageRaw) : null;
      const quantityRaw = form.get("quantity");
      const quantity = quantityRaw ? Number(quantityRaw) : 1;

      if (!category || !name) {
        return new Response(JSON.stringify({ error: "Category and name are required" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      // An uploaded photo wins; otherwise fall back to the stock image from the barcode lookup.
      if (purchasedOn && !/^\d{4}-\d{2}-\d{2}$/.test(purchasedOn)) return jsonError("Purchase date must be YYYY-MM-DD", 400);
      if (vintage !== null && !(Number.isInteger(vintage) && vintage >= 1800 && vintage <= 2100)) return jsonError("Vintage must be a year", 400);
      if (!(Number.isInteger(quantity) && quantity >= 1)) return jsonError("Quantity must be a whole number of 1 or more", 400);

      // Picked from the type-ahead: add to that row instead of creating a duplicate.
      let existing = null;
      const existingId = form.get("existing_id");
      if (existingId) {
        existing = await env.DB.prepare("SELECT id, quantity, vintage, photo_url FROM bottles WHERE id = ?").bind(existingId).first();
        if (!existing) return jsonError("That bottle isn't in the database any more — clear the form and try again", 404);
        // A different vintage of a wine you already have on hand is a separate bottle.
        if (category === "wine" && existing.quantity > 0 && vintage !== existing.vintage) existing = null;
      }

      let photo_url = null;
      const photo = form.get("photo");
      if (photo && typeof photo === "object" && photo.size > 0) {
        const nameParts = (photo.name || "bottle.jpg").split(".");
        const ext = (nameParts.length > 1 ? nameParts.pop() : "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
        photo_url = await storePhoto(env, await photo.arrayBuffer(), photo.type || "image/jpeg", ext);
      } else if (form.get("stock_image_url")) {
        // Copy it into R2 so the cellar doesn't depend on a third-party URL staying alive.
        // Best effort: if the download fails, the bottle is still saved, just without a photo.
        try {
          const stock = await fetchStockImage(form.get("stock_image_url"));
          if (stock) photo_url = await storePhoto(env, stock.bytes, stock.contentType, stock.ext);
        } catch (e) {}
      }

      if (existing) {
        // A new photo replaces the old one (and the old file goes); otherwise keep what it had.
        if (photo_url && existing.photo_url) {
          try { await env.PHOTOS.delete(existing.photo_url.replace("/photos/", "")); } catch (e) {}
        }
        await env.DB.prepare(
          "UPDATE bottles SET category = ?, name = ?, maker = ?, notes = ?, abv = ?, photo_url = ?, " +
          "purchased_on = COALESCE(?, purchased_on), vintage = ?, quantity = quantity + ? WHERE id = ?"
        ).bind(category, name, maker, notes, abv, photo_url || existing.photo_url, purchasedOn, vintage, quantity, existing.id).run();
        return Response.json({ ok: true, id: existing.id, updated: true });
      }

      const row = await env.DB.prepare(
        "INSERT INTO bottles (category, name, maker, notes, abv, photo_url, purchased_on, vintage, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
      ).bind(category, name, maker, notes, abv, photo_url, purchasedOn, vintage, quantity).first();

      return Response.json({ ok: true, id: row.id });
    }

    // --- Change how many of a bottle are on hand ---
    if (url.pathname.startsWith("/api/bottles/") && request.method === "PATCH") {
      if (!session) return jsonError("Sign in to update bottles", 401);
      const id = url.pathname.replace("/api/bottles/", "");
      let body = {};
      try {
        body = await request.json();
      } catch (e) {}
      // 0 = finished: it leaves the Cellar list but stays in the database for the type-ahead.
      const quantity = Number(body.quantity);
      if (!(Number.isInteger(quantity) && quantity >= 0)) return jsonError("Quantity must be a whole number, 0 or more", 400);

      const row = await env.DB.prepare("UPDATE bottles SET quantity = ? WHERE id = ? RETURNING id, quantity")
        .bind(quantity, id).first();
      if (!row) return jsonError("That bottle isn't in the Cellar", 404);
      return Response.json(row);
    }

    // --- Delete a bottle ---
    if (url.pathname.startsWith("/api/bottles/") && request.method === "DELETE") {
      if (!session) return jsonError("Sign in to remove bottles", 401);
      const id = url.pathname.replace("/api/bottles/", "");

      const row = await env.DB.prepare("SELECT photo_url FROM bottles WHERE id = ?").bind(id).first();
      if (row && row.photo_url) {
        const key = row.photo_url.replace("/photos/", "");
        try { await env.PHOTOS.delete(key); } catch (e) {}
      }
      await env.DB.prepare("DELETE FROM bottles WHERE id = ?").bind(id).run();
      return Response.json({ ok: true });
    }

    // --- What's on tap ---
    if (url.pathname === "/api/taps" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, status, beer, brewery, style, abv, level_pct, tapped_on, updated_at FROM taps ORDER BY id"
      ).all();
      return Response.json(results);
    }

    // --- Change a keg (or mark a tap out) ---
    if (url.pathname.startsWith("/api/taps/") && request.method === "PUT") {
      if (!session) return jsonError("Sign in to update the taps", 401);
      const id = url.pathname.replace("/api/taps/", "");
      let body = {};
      try {
        body = await request.json();
      } catch (e) {}

      const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
      const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
      const status = body.status;
      const beer = text(body.beer);
      const brewery = text(body.brewery);
      const style = text(body.style);
      const abv = num(body.abv);
      const levelPct = num(body.level_pct);
      const tappedOn = text(body.tapped_on);

      if (status !== "pouring" && status !== "empty") return jsonError("Status must be pouring or empty", 400);
      if (status === "pouring" && !beer) return jsonError("Name the beer that's pouring", 400);
      if (abv !== null && !(abv >= 0 && abv <= 100)) return jsonError("ABV must be between 0 and 100", 400);
      if (levelPct !== null && !(Number.isInteger(levelPct) && levelPct >= 0 && levelPct <= 100)) return jsonError("Keg level must be a whole percent from 0 to 100", 400);
      if (tappedOn && !/^\d{4}-\d{2}-\d{2}$/.test(tappedOn)) return jsonError("Tapped date must be YYYY-MM-DD", 400);

      const row = await env.DB.prepare(
        "UPDATE taps SET status = ?, beer = ?, brewery = ?, style = ?, abv = ?, level_pct = ?, tapped_on = ?, updated_at = CURRENT_TIMESTAMP " +
        "WHERE id = ? RETURNING id, status, beer, brewery, style, abv, level_pct, tapped_on, updated_at"
      ).bind(status, beer, brewery, style, abv, levelPct, tappedOn, id).first();
      if (!row) return jsonError("There's no tap " + id, 404);
      return Response.json(row);
    }

    // --- Latest kegerator readings: { sensor: { value, recorded_at } } ---
    if (url.pathname === "/api/sensors" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT sensor, value, recorded_at FROM sensor_readings WHERE id IN (SELECT MAX(id) FROM sensor_readings GROUP BY sensor)"
      ).all();
      const latest = {};
      for (const r of results) latest[r.sensor] = { value: r.value, recorded_at: r.recorded_at };
      return Response.json(latest);
    }

    // --- Record readings, e.g. {"fridge_temp_f": 37.2, "tap1_level_pct": 60} ---
    // Sensors authenticate with `Authorization: Bearer <SENSOR_TOKEN>`; a signed-in admin can post by hand.
    if (url.pathname === "/api/sensors" && request.method === "POST") {
      if (!session && !(await hasBearerToken(request, await readSecret(env.SENSOR_TOKEN)))) {
        return jsonError("Sign in or send a sensor token to record readings", 401);
      }
      let body = null;
      try {
        body = await request.json();
      } catch (e) {}
      if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("Send a JSON object of readings", 400);

      const entries = Object.entries(body);
      if (!entries.length) return jsonError("No readings sent", 400);
      for (const [sensor, value] of entries) {
        const range = SENSORS[sensor];
        if (!range) return jsonError(`Unknown sensor: ${sensor}`, 400);
        if (typeof value !== "number" || !(value >= range[0] && value <= range[1])) {
          return jsonError(`${sensor} must be a number from ${range[0]} to ${range[1]}`, 400);
        }
      }

      const cutoff = new Date(Date.now() - SENSOR_HISTORY_DAYS * 86400000).toISOString().slice(0, 19).replace("T", " ");
      const statements = [env.DB.prepare("DELETE FROM sensor_readings WHERE recorded_at < ?").bind(cutoff)];
      for (const [sensor, value] of entries) {
        statements.push(env.DB.prepare("INSERT INTO sensor_readings (sensor, value) VALUES (?, ?)").bind(sensor, value));
        const tap = /^tap(\d)_level_pct$/.exec(sensor);
        if (tap) {
          statements.push(
            env.DB.prepare("UPDATE taps SET level_pct = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(Math.round(value), Number(tap[1]))
          );
        }
      }
      await env.DB.batch(statements);
      return Response.json({ ok: true, recorded: entries.map(([sensor]) => sensor) });
    }

    // --- Serve a stored photo ---
    if (url.pathname.startsWith("/photos/") && request.method === "GET") {
      const key = url.pathname.replace("/photos/", "");
      const obj = await env.PHOTOS.get(key);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.body, {
        headers: {
          "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }

    // --- Barcode lookup proxy (keeps this server-side so no key/rate-limit abuse from the client) ---
    if (url.pathname === "/api/lookup" && request.method === "GET") {
      const upc = url.searchParams.get("upc");
      if (!upc) {
        return new Response(JSON.stringify({ error: "Missing upc" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      try {
        const data = await upcitemdb("lookup", { upc });
        const item = data.items && data.items[0];
        return Response.json({
          found: !!item,
          title: item?.title || null,
          brand: item?.brand || null,
          description: item?.description || null,
          images: (item?.images || []).filter((u) => /^https?:\/\//i.test(u)),
        });
      } catch (e) {
        return Response.json({ found: false, error: e.message });
      }
    }

    // --- Stock photo candidates for a product name (UPCitemdb product search) ---
    if (url.pathname === "/api/stock-photos" && request.method === "GET") {
      if (!session) return jsonError("Sign in to search stock photos", 401);
      const q = (url.searchParams.get("q") || "").trim().slice(0, 120);
      if (!q) return jsonError("Missing q", 400);
      try {
        const data = await upcitemdb("search", { s: q, match_mode: "0", type: "product" });
        return Response.json({ images: stockImagesFor(q, data.items || []) });
      } catch (e) {
        return Response.json({ images: [], error: e.message });
      }
    }

    // --- AI lookup: fill in bottle details from a label photo and/or a name ---
    // Signed-in only: every call costs money on the Anthropic account.
    if (url.pathname === "/api/identify" && request.method === "POST") {
      if (!session) return jsonError("Sign in to use the AI lookup", 401);
      let form;
      try {
        form = await request.formData();
      } catch (e) {
        return jsonError("Invalid form submission", 400);
      }
      const name = (form.get("name") || "").toString().trim().slice(0, 200) || null;
      let image = null;
      const photo = form.get("photo");
      if (photo && typeof photo === "object" && photo.size > 0) {
        const mediaType = (photo.type || "").toLowerCase();
        if (!IMAGE_EXTS[mediaType]) return jsonError("Photo must be a JPEG, PNG, WebP, or GIF", 400);
        if (photo.size > MAX_IDENTIFY_IMAGE_BYTES) return jsonError("Photo is too large — try a smaller one", 400);
        image = { data: bytesToBase64(await photo.arrayBuffer()), mediaType };
      }
      try {
        const result = await identifyBottle({
          apiKey: await readSecret(env.ANTHROPIC_API_KEY),
          model: env.CLAUDE_MODEL,
          image,
          name,
        });
        return Response.json(result);
      } catch (e) {
        if (e instanceof IdentifyError) return jsonError(e.message, e.status);
        return jsonError("AI lookup failed — try again", 502);
      }
    }

    // --- Fallback: serve the static site ---
    return env.ASSETS.fetch(request);
  },
};
