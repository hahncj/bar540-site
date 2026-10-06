import {
  allowedEmails,
  clearSessionCookie,
  createSessionCookie,
  readSecret,
  readSession,
  verifyGoogleIdToken,
} from "./auth.js";

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
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

    // --- List bottles ---
    if (url.pathname === "/api/bottles" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, category, name, maker, notes, abv, photo_url, added_at FROM bottles ORDER BY category, name"
      ).all();
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

      if (!category || !name) {
        return new Response(JSON.stringify({ error: "Category and name are required" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      let photo_url = null;
      const photo = form.get("photo");
      if (photo && typeof photo === "object" && photo.size > 0) {
        const nameParts = (photo.name || "bottle.jpg").split(".");
        const ext = (nameParts.length > 1 ? nameParts.pop() : "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
        const key = `${crypto.randomUUID()}.${ext}`;
        await env.PHOTOS.put(key, await photo.arrayBuffer(), {
          httpMetadata: { contentType: photo.type || "image/jpeg" },
        });
        photo_url = `/photos/${key}`;
      }

      await env.DB.prepare(
        "INSERT INTO bottles (category, name, maker, notes, abv, photo_url) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(category, name, maker, notes, abv, photo_url).run();

      return Response.json({ ok: true });
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
        const resp = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc)}`);
        const data = await resp.json();
        const item = data.items && data.items[0];
        return Response.json({
          found: !!item,
          title: item?.title || null,
          brand: item?.brand || null,
          description: item?.description || null,
          image: item?.images?.[0] || null,
        });
      } catch (e) {
        return Response.json({ found: false, error: "Lookup service unavailable" });
      }
    }

    // --- Fallback: serve the static site ---
    return env.ASSETS.fetch(request);
  },
};
