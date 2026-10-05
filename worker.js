export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- List bottles ---
    if (url.pathname === "/api/bottles" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, category, name, maker, notes, abv, photo_url, added_at FROM bottles ORDER BY category, name"
      ).all();
      return Response.json(results);
    }

    // --- Add a bottle ---
    if (url.pathname === "/api/bottles" && request.method === "POST") {
      let form;
      try {
        form = await request.formData();
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid form submission" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      const passcode = form.get("passcode");
      if (!env.BOTTLE_PASSCODE || passcode !== env.BOTTLE_PASSCODE) {
        return new Response(JSON.stringify({ error: "Wrong passcode" }), {
          status: 401,
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
