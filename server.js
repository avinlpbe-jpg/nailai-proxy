// NailAI Proxy — Full Server (Node 20)
// image providers: fal / replicate; demo fallback if both unavailable

const http = require("http");
const url = require("url");

const PORT  = process.env.PORT || 10000;

// Gemini (text)
const G_KEY   = process.env.GOOGLE_AI_KEY;
const G_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// order: "fal,replicate" | "replicate,fal" | "fal" | "replicate"
const PROVIDER_ORDER = (process.env.PROVIDER_ORDER || "fal,replicate")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

// Fal
const FAL_KEY   = process.env.FAL_KEY;
const FAL_MODEL = process.env.FAL_MODEL || "fal-ai/flux/schnell";

// Replicate
const R_TOKEN = process.env.REPLICATE_TOKEN;
const R_MODEL = process.env.REPLICATE_MODEL || "black-forest-labs/flux-schnell";

const DEMO_PLACEHOLDER = process.env.DEMO_PLACEHOLDER || "https://picsum.photos/768/1024";

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

// ---------- /prompt ----------
async function callGemini(model, prompt) {
  const endpoint = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${G_KEY}`;
  const payload = { contents: [{ role: "user", parts: [{ text: prompt }]}] };
  return fetchWithRetry(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}
function unique(arr){ return Array.from(new Set(arr.filter(Boolean))); }

async function handlePrompt(req, res, body) {
  try {
    if (!G_KEY) return send(res, 500, { error: "server_misconfig", details: "GOOGLE_AI_KEY is missing" });

    const { style, shape, purpose, decorations = [] } = JSON.parse(body || "{}");
    const prompt =
`Short photorealistic nail-art image prompt (<=160 chars).
Style: ${style}; Shape: ${shape}; Purpose: ${purpose}; Decorations: ${Array.isArray(decorations) ? decorations.join(", ") : ""}.
Studio background, soft natural light.`.trim();

    const candidates = unique([ G_MODEL, "gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-1.5-flash" ]);
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
      if ([503,502,404,400].includes(r.status)) { lastResp=r; lastData=data; continue; }
      lastResp=r; lastData=data; break;
    }
    return send(res, lastResp?.status ?? 502, { error: "gemini_api_error", details: lastData || { message:"Unknown" } });
  } catch (e) {
    return send(res, 500, { error: "server_error", details: String(e) });
  }
}

// ---------- providers: Fal ----------
async function falGenerate(prompt) {
  if (!FAL_KEY) return { ok:false, status:500, data:{ error:"fal_key_missing" } };
  const r = await fetch(`https://fal.run/${FAL_MODEL}`, {
    method: "POST",
    headers: { "Authorization": `Key ${FAL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt })
  });
  const data = await r.json().catch(() => ({}));
  if (r.ok) {
    const url = data?.images?.[0]?.url;
    return url ? { ok:true, status:200, data:{ imageUrl:url, provider:"fal", modelUsed:FAL_MODEL } }
               : { ok:false, status:502, data:{ error:"fal_empty_output", raw:data } };
  }
  return { ok:false, status:r.status, data };
}

// ---------- providers: Replicate ----------
async function replicateStart(modelPath, input) {
  const r = await fetch("https://api.replicate.com/v1/models/" + modelPath + "/predictions", {
    method: "POST",
    headers: { "Authorization": `Token ${R_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input })
  });
  const data = await r.json().catch(() => ({}));
  return { ok:r.ok, status:r.status, data };
}
async function replicateGet(id) {
  const r = await fetch("https://api.replicate.com/v1/predictions/" + id, {
    method: "GET",
    headers: { "Authorization": `Token ${R_TOKEN}` }
  });
  const data = await r.json().catch(() => ({}));
  return { ok:r.ok, status:r.status, data };
}
async function replicateGenerate(prompt) {
  if (!R_TOKEN) return { ok:false, status:500, data:{ error:"replicate_token_missing" } };
  const create = await replicateStart(R_MODEL, {
    prompt, width:768, height:1024, num_inference_steps:30, guidance_scale:7
  });
  if (!create.ok) return { ok:false, status:create.status, data:create.data };
  const id = create.data.id;
  for (let i=0;i<60;i++){
    await delay(2000);
    const check = await replicateGet(id);
    if (!check.ok) return { ok:false, status:check.status, data:check.data };
    const st = check.data.status;
    if (st === "succeeded") {
      const out = check.data.output;
      return (Array.isArray(out) && out.length>0)
        ? { ok:true, status:200, data:{ imageUrl: out[0], provider:"replicate", modelUsed:R_MODEL } }
        : { ok:false, status:502, data:{ error:"empty_output" } };
    }
    if (st === "failed" || st === "canceled") {
      return { ok:false, status:502, data:{ error:"replicate_failed", details: check.data.error || check.data } };
    }
  }
  return { ok:false, status:504, data:{ error:"replicate_timeout" } };
}

// ---------- Orchestrator ----------
async function handleImage(req, res, body) {
  try {
    const { prompt } = JSON.parse(body || "{}");
    const order = PROVIDER_ORDER.length ? PROVIDER_ORDER : ["fal","replicate"];
    console.log("[/image] providers order:", order.join(" → "));

    let last;
    for (const p of order) {
      if (p === "fal") {
        const result = await falGenerate(prompt);
        if (result.ok) return send(res, 200, result.data);
        const msg = JSON.stringify(result.data||{}).toLowerCase();
        const is402 = result.status === 402 || msg.includes("insufficient") || msg.includes("exhausted") || msg.includes("locked");
        if (is402) { console.log("[/image] Fal: insufficient/locked → next"); last=result; continue; }
        last = result; continue;
      }
      if (p === "replicate") {
        const result = await replicateGenerate(prompt);
        if (result.ok) return send(res, 200, result.data);
        const msg = JSON.stringify(result.data||{}).toLowerCase();
        const is402 = result.status === 402 || msg.includes("insufficient");
        if (is402) { console.log("[/image] Replicate: insufficient → next"); last=result; continue; }
        last = result; continue;
      }
    }

    // Demo fallback (לא חובה): תן תמונה זמנית כדי שה‑UI לא ייתקע
    if (DEMO_PLACEHOLDER) {
      console.log("[/image] all providers failed → demo placeholder");
      return send(res, 200, { imageUrl: DEMO_PLACEHOLDER, provider: "demo", modelUsed: "placeholder" });
    }

    return send(res, last?.status ?? 502,
      { error: "image_all_providers_failed", last: last?.data || { message: "No provider available" } });

  } catch (e) {
    return send(res, 500, { error: "server_error", details: String(e) });
  }
}

// ---------- /debug/models ----------
async function handleListModels(req, res) {
  try {
    if (!G_KEY) return send(res, 500, { error: "server_misconfig", details: "GOOGLE_AI_KEY is missing" });
    const r = await fetchWithRetry(`https://generativelanguage.googleapis.com/v1/models?key=${G_KEY}`, { method: "GET" });
    const data = await r.json().catch(() => ({}));
    return send(res, r.status, data);
  } catch (e) {
    return send(res, 500, { error: "server_error", details: String(e) });
  }
}

// ---------- HTTP Server ----------
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
