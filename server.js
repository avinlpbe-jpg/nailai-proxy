// NailAI Proxy — Full Server (Node 20)
// ------------------------------------
// Features:
// - CORS + OPTIONS
// - Google Gemini v1 payload (role: "user")
// - fetch timeout + retry/backoff on 503/502
// - model fallback chain (ENV first, then 1.5-flash-8b, 2.0-flash-lite)
// - forwards original HTTP status from Google to client
// - detailed logs to Render Logs

const http = require("http");
const url = require("url");

const PORT  = process.env.PORT || 10000;
const KEY   = process.env.GOOGLE_AI_KEY; // set in Render Environment
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

// ---- Small helpers ----
function unique(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

async function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// fetch with timeout and retry for transient 503/502
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
        const backoff = 600 * (1 << attempt); // 600ms, 1200ms, 2400ms
        console.log(`[Retry] transient ${r.status}. attempt=${attempt + 1}/${retries} backoff=${backoff}ms`);
        await delay(backoff);
        continue;
      }
      return r; // any non 503/502 status (including 200, 400, 401, 403, 429)
    } catch (e) {
      last = e;
      const backoff = 600 * (1 << attempt);
      console.log(`[Retry] network/timeout (${e?.name || e}). attempt=${attempt + 1}/${retries} backoff=${backoff}ms`);
      await delay(backoff);
    }
  }
  // after retries, if last is a Response return it, else throw
  if (last && typeof last === "object" && typeof last.status === "number") {
    return last;
  }
  throw last;
}

// ---- Core handler ----
async function handlePrompt(req, res, body) {
  try {
    if (!KEY) {
      return send(res, 500, { error: "server_misconfig", details: "GOOGLE_AI_KEY is missing" });
    }

    const { style, shape, purpose, decorations = [] } = JSON.parse(body || "{}");

    const prompt =
`Short photorealistic nail-art image prompt (<=160 chars).
Style: ${style}; Shape: ${shape}; Purpose: ${purpose}; Decorations: ${Array.isArray(decorations) ? decorations.join(", ") : ""}.
Studio background, soft natural light.`.trim();

    // v1 schema requires role: 'user'
    const payload = {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ]
    };

    // Fallback chain: ENV (primary) → 1.5-flash-8b → 2.0-flash-lite
    const models = unique([PRIMARY_MODEL, "gemini-1.5-flash-8b", "gemini-2.0-flash-lite"]);
    let lastResponse;
    let lastData;

    for (const model of models) {
      const endpoint = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${KEY}`;
      console.log(`[Gemini] calling model=${model}`);

      const r = await fetchWithRetry(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await r.json().catch(() => ({}));
      console.log(`[Gemini] status: ${r.status} model: ${model}`);
      if (!r.ok) {
        console.log(`[Gemini] error body: ${JSON.stringify(data)}`);
      }

      // If ok → return prompt
      if (r.ok) {
        const text = (data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
        return send(res, 200, { prompt: text, modelUsed: model });
      }

      // If transient (503/502) → try next model
      if (r.status === 503 || r.status === 502) {
        lastResponse = r; lastData = data;
        console.log(`[Gemini] transient ${r.status} on ${model}, trying next fallback if any...`);
        continue;
      }

      // Non-transient error (401/403/429/400/…) → break and forward it
      lastResponse = r; lastData = data;
      break;
    }

    // If reached here, forward last error/status from Google
    const status = lastResponse?.status ?? 502;
    return send(res, status, { error: "gemini_api_error", details: lastData || { message: "Unknown error" } });

  } catch (e) {
    console.log("[Server] exception:", e);
    return send(res, 500, { error: "server_error", details: String(e) });
  }
}

// ---- HTTP server ----
const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);

  // Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  // Health
  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/health")) {
    return send(res, 200, { ok: true, model: PRIMARY_MODEL });
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
