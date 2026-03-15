// NailAI Proxy — Full Server (Node 20)
// - CORS + OPTIONS
// - /prompt → Gemini v1 (role:"user"), retry + fallback סדר מודלים
// - /image  → ספקים מרובים לפי סדר ENV (fal/replicate); זיהוי 402 וחילופי ספק
// - /debug/models → רשימת מודלים זמינים ל-Gemini
// - לוגים מפורטים והחזרת סטטוס מקורי

const http = require("http");
const url = require("url");

// ---------- ENV ----------
const PORT  = process.env.PORT || 10000;

// Gemini (text)
const G_KEY   = process.env.GOOGLE_AI_KEY;
const G_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Providers order for /image: e.g. "fal,replicate" or "replicate,fal" or "fal"
const PROVIDER_ORDER = (process.env.PROVIDER_ORDER || "fal,replicate")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

// Fal.ai (image)
const FAL_KEY   = process.env.FAL_KEY;                    // "Key ..."
const FAL_MODEL = process.env.FAL_MODEL || "fal-ai/flux/schnell";

// Replicate (image)
const R_TOKEN = process.env.REPLICATE_TOKEN;              // "r8_..."
const R_MODEL = process.env.REPLICATE_MODEL || "black-forest-labs/flux-schnell";

// ---------- CORS ----------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
function send(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders });
  res.end(JSON.stringify(body));
}

// ---------- helpers ----------
const delay = (ms) => new Promise(r => setTimeout(r, ms));
function unique(arr) { return Array.from(new Set(arr.filter(Boolean))); }

async function fetchWithRetry(targetUrl, init, retries = 3) {
  let last;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 20000);
      const r = await fetch(targetUrl, { ...init, signal: controller.signal });
      clearTimeout(tid);

      if (r.status === 503 || r.status === 502) {
        last = r;
        const backoff = 600 * (1 << attempt);
        console.log(`[Retry] transient ${r.status}. attempt=${attempt+1}/${retries} backoff=${backoff}ms`);
        await delay(backoff);
        continue;
      }
      return r;
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

// =========================== /prompt (Gemini) ===============================
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
        lastResp = r; lastData = data; continue;
      }
      lastResp = r; lastData = data; break;
    }

    const status = lastResp?.status ?? 502;
    return send(res, status, { error: "gemini_api_error", details: lastData || { message: "Unknown error" } });

  } catch (e) {
    console.log("[Server] /prompt exception:", e);
    return send(res, 500, { error: "server_error", details: String(e) });
  }
}

// ====================== /image providers (Fal / Replicate) ==================

// ---- Fal ----
// לפי רפרנס fal: בקשה סינכרונית ל-https://fal.run/{model_id} עם Authorization: Key <FAL_KEY>
// התגובה כוללת images[0].url שנחזיר כ-imageUrl.
async function falGenerate(prompt) {
  if (!FAL_KEY) return { ok: false, status: 500, data: { error: "fal_key_missing" } };
  const endpoint = `https://fal.run/${FAL_MODEL}`;
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Key ${FAL_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ prompt })
  });
  const data = await r.json().catch(() => ({}));
  if (r.ok) {
    const url = data?.images?.[0]?.url;
    return url
      ? { ok: true, status: 200, data: { imageUrl: url, provider: "fal", modelUsed: FAL_MODEL } }
      : { ok: false, status: 502, data: { error: "fal_empty_output", raw: data } };
  }
  return { ok: false, status: r.status, data };
}

// ---- Replicate ----
async function replicateStart(modelPath, input) {
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
async function replicateGet(id) {
  const r = await fetch("https://api.replicate.com/v1/predictions/" + id, {
    method: "GET",
    headers: { "Authorization": `Token ${R_TOKEN}` }
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}
async function replicateGenerate(prompt) {
  if (!R_TOKEN) return { ok: false, status: 500, data: { error: "replicate_token_missing" } };

  const create = await replicateStart(R_MODEL, {
    prompt,
    width: 768,
    height: 1024,
    num_inference_steps: 30,
    guidance_scale: 7
  });
  if (!create.ok) return { ok: false, status: create.status, data: create.data };

  const id = create.data.id;
  for (let i = 0; i < 60; i++) {
    await delay(2000);
    const check = await replicateGet(id);
    if (!check.ok) return { ok: false, status: check.status, data: check.data };
    const st = check.data.status;
    if (st === "succeeded") {
      const out = check.data.output;
      if (Array.isArray(out) && out.length > 0) {
        return { ok: true, status: 200, data: { imageUrl: out[0], provider: "replicate", modelUsed: R_MODEL } };
      }
      return { ok: false, status: 502, data: { error: "empty_output" } };
    }
    if (st === "failed" || st === "canceled") {
      return { ok: false, status: 502, data: { error: "replicate_failed", details: check.data.error || check.data } };
    }
  }
  return { ok: false, status: 504, data: { error: "replicate_timeout" } };
}

// ---------- Orchestrator ----------
async function handleImage(req, res, body) {
  try {
    const { prompt, width, height, steps, guidance } = JSON.parse(body || "{}"); // הפרמטרים נשמרים ל-Replicate; Fal משתמש רק ב-prompt

    const order = PROVIDER_ORDER.length ? PROVIDER_ORDER : ["fal","replicate"];
    console.log("[/image] providers order:", order.join(" → "));

    let last;
    for (const p of order) {
      if (p === "fal") {
        const result = await falGenerate(prompt);
        if (result.ok) return send(res, 200, result.data);

        // אם אין יתרה/locked, נחפש ספק הבא (402 או הודעת insufficient/locked)
        const bodyStr = JSON.stringify(result.data || {});
        const is402 = result.status === 402 || bodyStr.toLowerCase().includes("insufficient") || bodyStr.toLowerCase().includes("exhausted");
        if (is402) {
          console.log("[/image] Fal: insufficient/locked → trying next provider");
          last = result; // נשמור מה היה, אבל נתקדם
          continue;
        }
        // שגיאה אחרת בפאל → אם יש ספק נוסף, ננסה אותו; אחרת נחזיר את השגיאה הזו
        last = result;
        continue;
      }

      if (p === "replicate") {
        const result = await replicateGenerate(prompt);
        if (result.ok) return send(res, 200, result.data);

        // אם אין קרדיט ב-Replicate (402 / title includes insufficient) → נסה ספק הבא אם יש
        const bodyStr = JSON.stringify(result.data || {});
        const is402 = result.status === 402 || bodyStr.toLowerCase().includes("insufficient");
        if (is402) {
          console.log("[/image] Replicate: insufficient → trying next provider");
          last = result;
          continue;
        }
        last = result;
        continue;
      }
    }

    // אם הגענו לכאן — כל הספקים נכשלו
    const status = last?.status ?? 502;
    return send(res, status, { error: "image_all_providers_failed", last: last?.data || { message: "No provider available" } });

  } catch (e) {
    console.log("[Server] /image exception:", e);
    return send(res, 500, { error: "server_error", details: String(e) });
  }
}

// ============================= /debug/models ================================
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

// ================================ HTTP Server ==============================
const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);

  if (req.method === "OPTIONS") { res.writeHead(204, CORS_HEADERS); return res.end(); }

  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/health")) {
    return send(res, 200, { ok: true, model: G_MODEL, providers: PROVIDER_ORDER });
  }

  if (req.method === "GET" && u.pathname === "/debug/models") {
    return handleListModels(req, res);
  }

  if (req.method === "POST" && u.pathname === "/prompt") {
    let body = ""; req.on("data", ch => (body += ch)); req.on("end", () => handlePrompt(req, res, body)); return;
  }

  if (req.method === "POST" && u.pathname === "/image") {
    let body = ""; req.on("data", ch => (body += ch)); req.on("end", () => handleImage(req, res, body)); return;
  }

  return send(res, 404, { error: "not_found" });
});

server.listen(PORT, () => console.log("NailAI proxy listening on", PORT));
