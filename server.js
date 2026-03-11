// NailAI Proxy — Full Server (Node 20)
// CORS + OPTIONS, v1 payload (role:"user"), retry/backoff, model fallback,
// /debug/models to list available models for your API key, and logs.

const http = require("http");
const url = require("url");

const PORT  = process.env.PORT || 10000;
const KEY   = process.env.GOOGLE_AI_KEY;                // חייב להיות מוגדר ב-Render
const PRIMARY_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

// ---- CORS ----
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function send(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders });
  res.end(JSON.stringify(body));
}

// ---- helpers ----
function unique(arr) { return Array.from(new Set(arr.filter(Boolean))); }
const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, init, retries = 3) {
  let last;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 20000); // 20s timeout
      const r = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(tid);

      if (r.status === 503 || r.status === 502) {
        last = r;
        const backoff = 600 * (1 << attempt);
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

// ---- Gemini v1 call ----
async function callGemini(model, prompt) {
  const endpoint = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${KEY}`;
  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }]}]
  };
  return fetchWithRetry(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

// ---- /prompt handler ----
async function handlePrompt(req, res, body) {
  try {
    if (!KEY) return send(res, 500, { error: "server_misconfig", details: "GOOGLE_AI_KEY is missing" });

    const { style, shape, purpose, decorations = [] } = JSON.parse(body || "{}");
    const prompt =
`Short photorealistic nail-art image prompt (<=160 chars).
Style: ${style}; Shape: ${shape}; Purpose: ${purpose}; Decorations: ${Array.isArray(decorations) ? decorations.join(", ") : ""}.
Studio background, soft natural light.`.trim();

    // סדר מודלים: ENV → 2.0-flash → 2.0-flash-lite → 1.5-flash → 1.5-pro (לבחינת זמינות)
    const candidates = unique([
      PRIMARY_MODEL,
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
      "gemini-1.5-flash",
      "gemini-1.5-pro"
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

      // אם מודל לא נמצא/לא נתמך (404/400 עם NOT_FOUND/unsupported) → נסה הבא
      if (r.status === 404 || r.status === 400) { lastResp = r; lastData = data; continue; }
      // זמני (503/502) → ננסה הבא
      if (r.status === 503 || r.status === 502) { lastResp = r; lastData = data; continue; }
      // שגיאות אחרות (401/403/429...) → עצר והחזר
      lastResp = r; lastData = data; break;
    }

    const status = lastResp?.status ?? 502;
    return send(res, status, { error: "gemini_api_error", details: lastData || { message: "Unknown error" } });

  } catch (e) {
    console.log("[Server] exception:", e);
    return send(res, 500, { error: "server_error", details: String(e) });
  }
}

// ---- /debug/models: מחזיר רשימת מודלים זמינים ל-KEY ----
async function handleListModels(req, res) {
  try {
    if (!KEY) return send(res, 500, { error: "server_misconfig", details: "GOOGLE_AI_KEY is missing" });
    const endpoint = `https://generativelanguage.googleapis.com/v1/models?key=${KEY}`;
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

// ---- HTTP Server ----
const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);

  // Preflight
  if (req.method === "OPTIONS") { res.writeHead(204, CORS_HEADERS); return res.end(); }

  // Health
  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/health")) {
    return send(res, 200, { ok: true, model: PRIMARY_MODEL });
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

  return send(res, 404, { error: "not_found" });
});

server.listen(PORT, () => console.log("NailAI proxy listening on", PORT));
