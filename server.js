// NailAI Proxy — Leonardo Edition (Node 20)
// -----------------------------------------
// Endpoints:
//   GET  /health          -> סטטוס חיים
//   GET  /leonardo-test   -> בדיקת מפתח Leonardo בענן (ענן->ענן)
//   POST /prompt          -> Gemini v1 (יצירת טקסט prompt)
//   POST /image           -> Leonardo (POST /generations + polling GET /generations/{id})
//
// ENV (Render -> Settings -> Environment):
//   GOOGLE_AI_KEY   = <מפתח Gemini>
//   GEMINI_MODEL    = gemini-2.5-flash
//   LEONARDO_KEY    = <API KEY של Leonardo>  // בלי "Bearer"
//   LEONARDO_MODEL  = <UUID של מודל Leonardo> // לדוגמה Flux Schnell: 1dd50843-d653-4516-a8e3-f0238ee453ff
//
// הערות:
// - בסיס ה-API של Leonardo: https://cloud.leonardo.ai/api/rest/v1  (Bearer <API_KEY>)
// - יצירה אסינכרונית: POST /generations -> אח"כ GET /generations/{id} עד שיש generated_images
// - שימו לב למיפוי שמות הפרמטרים עבור Leonardo:
//     steps            -> num_inference_steps
//     guidance         -> guidance_scale
//     negativePrompt   -> negative_prompt
//
// Node 20 כולל fetch גלובלי.

const http = require("http");
const url = require("url");

const PORT  = process.env.PORT || 10000;

// Gemini
const G_KEY   = process.env.GOOGLE_AI_KEY;
const G_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Leonardo
const L_KEY   = process.env.LEONARDO_KEY;   // רק ה-KEY (בלי "Bearer")
const L_MODEL = process.env.LEONARDO_MODEL; // UUID של המודל

// CORS
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function send(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders });
  res.end(JSON.stringify(body));
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));
async function fetchJSON(endpoint, init = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(endpoint, { ...init, signal: controller.signal });
    const data = await r.json().catch(() => ({}));
    return { r, data };
  } finally { clearTimeout(t); }
}

/* ------------------------------ /health ------------------------------------ */
function handleHealth(req, res) {
  return send(res, 200, { ok: true, promptModel: G_MODEL || null, imageModel: L_MODEL || null });
}

/* --------------------------- /leonardo-test -------------------------------- */
async function handleLeonardoTest(req, res) {
  if (!L_KEY) return send(res, 500, { error: "missing_LEONARDO_KEY" });

  const { r, data } = await fetchJSON("https://cloud.leonardo.ai/api/rest/v1/me", {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${L_KEY}`,
      "Accept": "application/json"
    }
  });

  return send(res, r.status, data);
}

/* -------------------------------- /prompt ---------------------------------- */
async function handlePrompt(req, res, body) {
  try {
    if (!G_KEY) return send(res, 500, { error: "missing_GOOGLE_AI_KEY" });

    const { style, shape, purpose, decorations = [] } = JSON.parse(body || "{}");

    const textPrompt =
`Short photorealistic nail-art image prompt (<=160 chars).
Style: ${style}; Shape: ${shape}; Purpose: ${purpose};
Decorations: ${Array.isArray(decorations) ? decorations.join(", ") : ""}.
Studio background, soft natural light.`;

    const endpoint =
      `https://generativelanguage.googleapis.com/v1/models/${G_MODEL}:generateContent?key=${G_KEY}`;

    const payload = { contents: [{ role: "user", parts: [{ text: textPrompt }]}] };

    const { r, data } = await fetchJSON(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      console.log("[Gemini] status:", r.status, "body:", data);
      return send(res, r.status, { error: "gemini_error", details: data });
    }

    const out = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!out) return send(res, 500, { error: "no_prompt" });

    return send(res, 200, { prompt: out, modelUsed: G_MODEL });
  } catch (e) {
    console.log("[/prompt] exception:", e);
    return send(res, 500, { error: "server_exception", details: String(e) });
  }
}

/* -------------------------------- /image ----------------------------------- */
// body שמתקבל מהלקוח (Flutter / Hoppscotch):
// {
//   "prompt": "...",           // חובה
//   "width": 768,              // אופציונלי (ברירת מחדל 768)
//   "height": 1024,            // אופציונלי (ברירת מחדל 1024)
//   "numImages": 1,            // אופציונלי
//   "negativePrompt": "...",   // אופציונלי
//   "steps": 32,               // אופציונלי (ימופה ל-num_inference_steps)
//   "guidance": 4.0            // אופציונלי (ימופה ל-guidance_scale)
// }

async function leonardoCreate({
  prompt,
  width = 768,
  height = 1024,
  numImages = 1,
  negativePrompt = "",
  steps,      // יגיע מהלקוח
  guidance,   // יגיע מהלקוח
}) {
  const endpoint = "https://cloud.leonardo.ai/api/rest/v1/generations";

  // מיפוי שמות לשדות ש-Leonardo מצפה להם:
  const payload = {
    prompt,
    modelId: L_MODEL,                 // UUID תקף
    width,
    height,
    num_images: numImages,
    ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
    ...(typeof steps === "number"    ? { num_inference_steps: steps } : {}),
    ...(typeof guidance === "number" ? { guidance_scale: guidance } : {}),
  };

  return fetchJSON(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${L_KEY}`,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

async function leonardoGet(generationId) {
  const endpoint = `https://cloud.leonardo.ai/api/rest/v1/generations/${generationId}`;
  return fetchJSON(endpoint, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${L_KEY}`,
      "Accept": "application/json"
    }
  });
}

async function handleImage(req, res, body) {
  try {
    if (!L_KEY)   return send(res, 500, { error: "missing_LEONARDO_KEY" });
    if (!L_MODEL) return send(res, 500, { error: "missing_LEONARDO_MODEL_UUID" });

    const {
      prompt,
      width = 768,
      height = 1024,
      numImages = 1,
      negativePrompt = "",
      steps,
      guidance
    } = JSON.parse(body || "{}");

    if (!prompt || String(prompt).trim().length === 0) {
      return send(res, 400, { error: "missing_prompt" });
    }

    // 1) יצירה
    const { r: rCreate, data: dCreate } = await leonardoCreate({
      prompt, width, height, numImages, negativePrompt, steps, guidance
    });

    if (!rCreate.ok) {
      console.log("[Leonardo] create status:", rCreate.status, "body:", dCreate);
      return send(res, rCreate.status, { error: "leonardo_error", details: dCreate });
    }

    // 2) polling עד שיש תמונה
    const genId =
      dCreate?.sdGenerationJob?.generationId ||
      dCreate?.generationId ||
      dCreate?.id;

    if (!genId) return send(res, 500, { error: "no_generation_id", raw: dCreate });

    for (let i = 0; i < 60; i++) { // עד ~120 שניות
      await delay(2000);

      const { r: rGet, data: dGet } = await leonardoGet(genId);
      if (!rGet.ok) {
        console.log("[Leonardo] get status:", rGet.status, "body:", dGet);
        return send(res, rGet.status, { error: "leonardo_error", details: dGet });
      }

      const status =
        dGet?.generations_by_pk?.status ||
        dGet?.status || "";

      const imagesArr =
        dGet?.generations_by_pk?.generated_images ||
        dGet?.generated_images ||
        [];

      if (Array.isArray(imagesArr) && imagesArr.length > 0) {
        const url = imagesArr[0]?.url;
        if (url) {
          return send(res, 200, { imageUrl: url, provider: "leonardo", modelUsed: L_MODEL });
        }
      }

      if (String(status).toUpperCase().includes("FAILED")) {
        return send(res, 502, { error: "leonardo_failed", details: dGet });
      }
      // אחרת: PENDING/PROCESSING → נמשיך להמתין
    }

    return send(res, 504, { error: "leonardo_timeout" });

  } catch (e) {
    console.log("[/image] exception:", e);
    return send(res, 500, { error: "server_exception", details: String(e) });
  }
}

/* ------------------------------ HTTP Server -------------------------------- */
const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/health")) {
    return handleHealth(req, res);
  }

  if (req.method === "GET" && u.pathname === "/leonardo-test") {
    return handleLeonardoTest(req, res);
  }

  if (req.method === "POST" && u.pathname === "/prompt") {
    let body = ""; req.on("data", c => (body += c)); req.on("end", () => handlePrompt(req, res, body)); return;
  }

  if (req.method === "POST" && u.pathname === "/image") {
    let body = ""; req.on("data", c => (body += c)); req.on("end", () => handleImage(req, res, body)); return;
  }

  return send(res, 404, { error: "not_found" });
});

server.listen(PORT, () => console.log("NailAI Leonardo Proxy running on", PORT));
