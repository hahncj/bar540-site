// Bottle identification with Claude: a label photo and/or a typed name in, form fields out.
// Plain fetch against the Messages API (no SDK), so it runs anywhere fetch does.

const API_URL = "https://api.anthropic.com/v1/messages";
export const DEFAULT_MODEL = "claude-opus-5-5";

const SYSTEM = `You help catalog a family home bar. Given a photo of a bottle or can (and/or a product name someone typed), identify the product and fill in the details for the bar's inventory form.

- category: "whiskey" for any whiskey/bourbon/rye/scotch, "wine" for wine, sparkling wine, or champagne, "beer" for beer, cider, or seltzer. Any other spirit (rum, vodka, tequila, gin...) or anything you can't tell: null.
- name: the product as people would say it, including the expression or age statement (e.g. "Eagle Rare 10 Year", "Caymus Cabernet Sauvignon"). Leave out the vintage and the bottle size.
- maker: the distillery, winery, or brewery.
- abv: the alcohol by volume as a number (45, not "45%"). Use the label when it's readable; otherwise the product's standard ABV if you know it well; otherwise null.
- vintage: for wine only, the year on the label; otherwise null.
- notes: two short sentences of tasting notes in a relaxed, friendly voice, based on what this product is known for. null if you don't recognize it.
- confident: true if you are sure what the product is; false if you are guessing from a partial or blurry label.

If the photo isn't a drink at all, return null for everything and confident: false. Never invent a product name you can't read or recognize.`;

const SCHEMA = {
  type: "object",
  properties: {
    category: { anyOf: [{ type: "string", enum: ["whiskey", "wine", "beer"] }, { type: "null" }] },
    name: { type: ["string", "null"] },
    maker: { type: ["string", "null"] },
    abv: { type: ["number", "null"] },
    vintage: { type: ["integer", "null"] },
    notes: { type: ["string", "null"] },
    confident: { type: "boolean" },
  },
  required: ["category", "name", "maker", "abv", "vintage", "notes", "confident"],
  additionalProperties: false,
};

export class IdentifyError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// image: { data: base64 string, mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" } or null
// name: what the user typed, or null. At least one is required.
export async function identifyBottle({ apiKey, model, image, name }) {
  if (!apiKey) throw new IdentifyError("AI lookup isn't set up (missing ANTHROPIC_API_KEY)", 500);
  if (!image && !name) throw new IdentifyError("Send a photo or a name to look up", 400);

  const content = [];
  if (image) content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
  content.push({
    type: "text",
    text: image
      ? (name ? `Identify this bottle. The person typed: "${name}".` : "Identify this bottle.")
      : `Identify this product from its name: "${name}".`,
  });

  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // If a safety classifier declines, the API re-runs the request on Anthropic's recommended fallback model.
      "anthropic-beta": "server-side-fallback-2026-07-01",
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content }],
    }),
  });

  const body = await resp.json().catch(() => null);
  if (!resp.ok) {
    const detail = body?.error?.message || `HTTP ${resp.status}`;
    if (resp.status === 401 || resp.status === 403) throw new IdentifyError("The AI API key was rejected: " + detail, 502);
    if (resp.status === 429 || resp.status === 529) throw new IdentifyError("The AI service is busy — try again in a minute", 503);
    throw new IdentifyError("AI lookup failed: " + detail, 502);
  }
  if (body.stop_reason === "refusal") throw new IdentifyError("The AI declined to identify that photo", 422);
  if (body.stop_reason === "max_tokens") throw new IdentifyError("The AI response was cut off — try again", 502);

  const text = (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let result;
  try {
    result = JSON.parse(text);
  } catch (e) {
    throw new IdentifyError("The AI response wasn't readable — try again", 502);
  }
  return {
    ...result,
    usage: { input_tokens: body.usage?.input_tokens, output_tokens: body.usage?.output_tokens },
  };
}
