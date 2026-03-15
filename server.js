// NailAI Proxy — Full Server (Node 20)
// - CORS + OPTIONS
// - /prompt → Google Gemini v1 (role:"user"), retry + fallback
// - /image  → Replicate REST (owner/model), polling עד URL של תמונה
// - /debug/models → רשימת מודלים זמינים ל-KEY של Gemini
// - לוגים מפורטים ומחזיר סטטוס מקורי ללקוח

const http = require("http");
const url = require("url");

const PORT  = process.env.PORT || 10000;

// --- Gemini (Text Prompt) ---
const G_KEY   = process.env.GOOGLE_AI_KEY;                       // חובה להגדיר ב-Render
const G_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";  // מומלץ 2.5-flash

// --- Replicate (Image Gen) ---
const R_TOKEN = process.env.REPLICATE_TOKEN;                     // "r8_..."
const R_MODEL = process.env.REPLICATE_MODEL || "black-forest-labs/flux-schnell";

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
function unique(arr) { return Array.from(new Set(arr.filter(Boolean))); }

async function fetchWithRetry(targetUrl, init, retries = 3) {
  let last;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 20000); // 20s timeout
      const r = await fetch(targetUrl, { ...init, signal: controller.signal });
      clearTimeout(tid);

      if (r.status === 503 || r.status === 502) {
        last = r;
        const backoff = 600 * (1 << attempt); // 600, 1200, 2400 ms
        console.log(`[Retry] transient ${r.status}. attempt=${attempt+1}/${retries} backoff=${backoff}ms`);
        await delay(backoff);
        continue;
      }
      return r; // 200/400/401/403/404/429...
    } catch (e) {
      last = e;
      const backoff = 600 * (1 << attempt);
      console.log(`[Retry] network/timeout (${e?.name || e}). attempt=${attempt+1}/${retries} backoff=${backoff}ms`);
      await delay(backoff);
    }
  }
  if (last && typeof last === "object" && typeof last.status === "number") return last;
  throw last;
}

/* ----------------------------- /prompt (Gemini) ---------------------------- */

async function callGemini(model, prompt) {
  const endpoint = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${G_KEY}`;
  const payload = { contents: [{ role: "user", parts: [{ text: prompt }]}] };
  return fetchWithRetry(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function handlePrompt(req, res, body) {
  try {
    if (!G_KEY) return send(res, 500, { error: "server_misconfig", details: "GOOGLE_AI_KEY is missing" });

    const { style, shape, purpose, decorations = [] } = JSON.parse(body || "{}");

    const prompt =
`Short photorealistic nail-art image prompt (<=160 chars).
Style: ${style}; Shape: ${shape}; Purpose: ${purpose}; Decorations: ${Array.isArray(decorations) ? decorations.join(", ") : ""}.
Studio background, soft natural light.`.trim();

    const candidates = unique([
      G_MODEL,
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
      "gemini-1.5-flash"
    ]);

    let lastResp, lastData;

    for (const model of candidates) {
      console.log(`[Gemini] calling model=${model}`);
      const r = await callGemini(model, prompt);
      const data = await r.json().catch(() => ({}));
      console.log(`[Gemini] status: ${r.status} model: ${model}`);
      if (!r.ok) console.log(`[Gemini] error body: ${JSON.stringify(data)}`);

      if (r.ok) {
        const text = (data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
        return send(res, 200, { prompt: text, modelUsed: model });
      }

      if (r.status === 503 || r.status === 502 || r.status === 404 || r.status === 400) {
        lastResp = r; lastData = data; continue;   // ננסה מודל הבא
      }
      lastResp = r; lastData = data; break;        // 401/403/429/אחר → יוצאים
    }

    const status = lastResp?.status ?? 502;
    return send(res, status, { error: "gemini_api_error", details: lastData || { message: "Unknown error" } });

  } catch (e) {
    console.log("[Server] /prompt exception:", e);
    return send(res, 500, { error: "server_error", details: String(e) });
  }
}

/* ------------------------------ /image (Replicate) ------------------------- */

async function startReplicatePrediction(modelPath, input) {
  const r = await fetch("https://api.replicate.com/v1/models/" + modelPath + "/predictions", {
    method: "POST",
    headers: {
      "Authorization": `Token ${R_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ input })
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

async function getReplicatePrediction(id) {
  const r = await fetch("https://api.replicate.com/v1/predictions/" + id, {
    method: "GET",
    headers: { "Authorization": `Token ${R_TOKEN}` }
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

async function handleImage(req, res, body) {
  try {
    if (!R_TOKEN) return send(res, 500, { error: "server_misconfig", details: "REPLICATE_TOKEN is missing" });

    const { prompt, width = 768, height = 1024, steps = 30, guidance = 7 } = JSON.parse(body || "{}");

    // יצירת prediction
    const create = await startReplicatePrediction(R_MODEL, {
      prompt,
      width,
      height,
      num_inference_steps: steps,
      guidance_scale: guidance
    });

    if (!create.ok) {
      return send(res, create.status, { error: "replicate_create_error", details: create.data });
    }

    const id = create.data.id;

    // Polling עד succeeded/failed (עד ~120 שניות)
    for (let i = 0; i < 60; i++) {
      await delay(2000);
      const check = await getReplicatePrediction(id);
      if (!check.ok) {
        return send(res, check.status, { error: "replicate_poll_error", details: check.data });
      }
      const st = check.data.status; // starting | processing | succeeded | failed | canceled
      if (st === "succeeded") {
        const out = check.data.output;
        if (Array.isArray(out) && out.length > 0) {
          return send(res, 200, { imageUrl: out[0], provider: "replicate", modelUsed: R_MODEL });
        }
        return send(res, 502, { error: "empty_output" });
      }
      if (st === "failed" || st === "canceled") {
        return send(res, 502, { error: "replicate_failed", details: check.data.error || check.data });
      }
      // otherwise: starting/processing → נמשיך לחכות
    }

    return send(res, 504, { error: "replicate_timeout" });

  } catch (e) {
    console.log("[Server] /image exception:", e);
    return send(res, 500, { error: "server_error", details: String(e) });
  }
}

/* ------------------------------- /debug/models ----------------------------- */

async function handleListModels(req, res) {
  try {
    if (!G_KEY) return send(res, 500, { error: "server_misconfig", details: "GOOGLE_AI_KEY is missing" });
    const endpoint = `https://generativelanguage.googleapis.com/v1/models?key=${G_KEY}`;
    const r = await fetchWithRetry(endpoint, { method: "GET" });
    const data = await r.json().catch(() => ({}));
    console.log(`[Models] status: ${r.status}`);
    if (!r.ok) console.log(`[Models] error: ${JSON.stringify(data)}`);
    return send(res, r.status, data);
  } catch (e) {
    console.log("[Models] exception:", e);
    return send(res, 500, { error: "server_error", details: String(e) });
  }
}

/* -------------------------------- HTTP Server ------------------------------ */

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);

  // Preflight
  if (req.method === "OPTIONS") { res.writeHead(204, CORS_HEADERS); return res.end(); }

  // Health
  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/health")) {
    return send(res, 200, { ok: true, model: G_MODEL });
  }

  // Debug: list models available for this key
  if (req.method === "GET" && u.pathname === "/debug/models") {
    return handleListModels(req, res);
  }

  // Prompt
  if (req.method === "POST" && u.pathname === "/prompt") {
    let body = "";
    req.on("data", ch => (body += ch));
    req.on("end", () => handlePrompt(req, res, body));
    return;
  }

  // Image
  if (req.method === "POST" && u.pathname === "/image") {
    let body = "";
    req.on("data", ch => (body += ch));
    req.on("end", () => handleImage(req, res, body));
    return;
  }

  return send(res, 404, { error: "not_found" });
});

server.listen(PORT, () => console.log("NailAI proxy listening on", PORT));
