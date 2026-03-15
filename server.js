// NailAI Proxy — Full Server (Node 20)
// - CORS + OPTIONS
// - /prompt → Google Gemini v1 (role:"user"), retry + fallback סדר מודלים
// - /image  → Replicate; אם אין קרדיט/402 → Fallback ל‑Fal.ai
// - /debug/models → רשימת מודלים זמינים ל‑Gemini
// - לוגים מפורטים ומחזיר סטטוס מקורי ללקוח

const http = require("http");
const url = require("url");

const PORT  = process.env.PORT || 10000;

// --- Gemini (Text Prompt) ---
const G_KEY   = process.env.GOOGLE_AI_KEY;                      // חובה
const G_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash"; // מומלץ

// --- Replicate (Image Gen) ---
const R_TOKEN = process.env.REPLICATE_TOKEN;                    // "r8_..."
const R_MODEL = process.env.REPLICATE_MODEL || "black-forest-labs/flux-schnell";

// --- Fal.ai (Image Gen Fallback) ---
const FAL_KEY   = process.env.FAL_KEY;                          // "Key xxx" (fal dashboard)
const FAL_MODEL = process.env.FAL_MODEL || "fal-ai/flux/schnell";

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
      const tid = setTimeout(() => controller.abort(), 20000); // 20s
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

/* ----------------------- /image (Replicate → Fal Fallback) ----------------- */

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

async function falGenerate(prompt, width, height, steps, guidance) {
  if (!FAL_KEY) return { ok: false, status: 500, data: { error: "fal_key_missing" } };

  // לפי הדוקומנטציה של Fal, קריאה סינכרונית:
  // POST https://fal.run/{model_id}  עם Authorization: Key <FAL_KEY>  ומתקבל images[0].url
  // (נשתמש ב‑fal-ai/flux/schnell כברירת מחדל)  [1](https://docs.fal.ai/model-apis/model-endpoints/synchronous-requests)
  const endpoint = `https://fal.run/${FAL_MODEL}`;
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Key ${FAL_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      prompt,
      // פרמטרים אופציונליים — מודלים שונים מתעלמים/מתייחסים אחרת; נשאיר מינימלי ואמין.
      // אפשר להוסיף image_size/num_inference_steps וכו' לפי הצורך. [2](https://docs.fal.ai/model-apis/fast-flux)
    })
  });

  const data = await r.json().catch(() => ({}));
  if (r.ok) {
    const url = data?.images?.[0]?.url;
    if (url) return { ok: true, status: 200, data: { imageUrl: url, provider: "fal", modelUsed: FAL_MODEL } };
    return { ok: false, status: 502, data: { error: "fal_empty_output", raw: data } };
  }
  return { ok: false, status: r.status, data };
}

async function handleImage(req, res, body) {
  try {
    const { prompt, width = 768, height = 1024, steps = 30, guidance = 7 } = JSON.parse(body || "{}");

    // 1) אם יש טוקן Replicate — ננסה תחילה שם (אולי יש לך קרדיט)
    if (R_TOKEN) {
      const create = await replicateStart(R_MODEL, {
        prompt,
        width,
        height,
        num_inference_steps: steps,
        guidance_scale: guidance
      });

      // אם נוצר prediction — נבצע polling עד URL
      if (create.ok) {
        const id = create.data.id;
        for (let i = 0; i < 60; i++) {
          await delay(2000);
          const check = await replicateGet(id);
          if (!check.ok) {
            // אם יש FAL_KEY — נפיל Fallback מיד
            if (FAL_KEY) {
              console.log("[/image] replicate poll error → fallback to Fal");
              const fal = await falGenerate(prompt, width, height, steps, guidance);
              return send(res, fal.status, fal.ok ? fal.data : { error: "fal_error", details: fal.data });
            }
            return send(res, check.status, { error: "replicate_poll_error", details: check.data });
          }
          const st = check.data.status; // starting | processing | succeeded | failed | canceled
          if (st === "succeeded") {
            const out = check.data.output;
            if (Array.isArray(out) && out.length > 0) {
              return send(res, 200, { imageUrl: out[0], provider: "replicate", modelUsed: R_MODEL });
            }
            // אין פלט → נסה Fal אם זמין
            if (FAL_KEY) {
              console.log("[/image] replicate empty output → fallback to Fal");
              const fal = await falGenerate(prompt, width, height, steps, guidance);
              return send(res, fal.status, fal.ok ? fal.data : { error: "fal_error", details: fal.data });
            }
            return send(res, 502, { error: "empty_output" });
          }
          if (st === "failed" || st === "canceled") {
            // כשל → נסה Fal אם זמין
            if (FAL_KEY) {
              console.log("[/image] replicate failed/canceled → fallback to Fal");
              const fal = await falGenerate(prompt, width, height, steps, guidance);
              return send(res, fal.status, fal.ok ? fal.data : { error: "fal_error", details: fal.data });
            }
            return send(res, 502, { error: "replicate_failed", details: check.data.error || check.data });
          }
        }
        // timeout → ננסה Fal אם זמין
        if (FAL_KEY) {
          console.log("[/image] replicate timeout → fallback to Fal");
          const fal = await falGenerate(prompt, width, height, steps, guidance);
          return send(res, fal.status, fal.ok ? fal.data : { error: "fal_error", details: fal.data });
        }
        return send(res, 504, { error: "replicate_timeout" });
      }

      // create לא הצליח. אם 402/Insufficient credit → Fallback ל‑Fal
      const insufficient =
        create.status === 402 ||
        (typeof create.data?.title === "string" && create.data.title.toLowerCase().includes("insufficient"));

      if (insufficient && FAL_KEY) {
        console.log("[/image] replicate 402 insufficient credit → fallback to Fal");
        const fal = await falGenerate(prompt, width, height, steps, guidance);
        return send(res, fal.status, fal.ok ? fal.data : { error: "fal_error", details: fal.data });
      }

      // אין FAL או שגיאה אחרת
      return send(res, create.status, { error: "replicate_create_error", details: create.data });
    }

    // 2) אין R_TOKEN? — אם יש Fal, נשתמש בו ישירות
    if (FAL_KEY) {
      const fal = await falGenerate(prompt, width, height, steps, guidance);
      return send(res, fal.status, fal.ok ? fal.data : { error: "fal_error", details: fal.data });
    }

    // 3) אין אף ספק
    return send(res, 500, { error: "server_misconfig", details: "No REPLICATE_TOKEN or FAL_KEY configured" });

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

  if (req.method === "OPTIONS") { res.writeHead(204, CORS_HEADERS); return res.end(); }

  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/health")) {
    return send(res, 200, { ok: true, model: G_MODEL });
  }

  if (req.method === "GET" && u.pathname === "/debug/models") {
    return handleListModels(req, res);
  }

  if (req.method === "POST" && u.pathname === "/prompt") {
    let body = "";
    req.on("data", ch => (body += ch));
    req.on("end", () => handlePrompt(req, res, body));
    return;
  }

  if (req.method === "POST" && u.pathname === "/image") {
    let body = "";
    req.on("data", ch => (body += ch));
    req.on("end", () => handleImage(req, res, body));
    return;
  }

  return send(res, 404, { error: "not_found" });
});

server.listen(PORT, () => console.log("NailAI proxy listening on", PORT));
