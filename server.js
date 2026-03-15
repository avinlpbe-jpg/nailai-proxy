// NailAI Proxy — Leonardo Edition (Node 20)
// -----------------------------------------
// Endpoints:
//   POST /prompt  -> Gemini (טקסט בלבד)
//   POST /image   -> Leonardo AI (תמונה)
//   GET  /health  -> סטטוס
//
// דרישות ENV ב-Render:
//   GOOGLE_AI_KEY
//   GEMINI_MODEL (למשל gemini-2.5-flash)
//   LEONARDO_KEY
//   LEONARDO_MODEL (למשל leonardo-creative)
// -----------------------------------------

const http = require("http");
const url = require("url");

const PORT = process.env.PORT || 10000;

// Gemini (Prompt)
const G_KEY   = process.env.GOOGLE_AI_KEY;
const G_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Leonardo (Images)
const L_KEY   = process.env.LEONARDO_KEY;
const L_MODEL = process.env.LEONARDO_MODEL || "leonardo-creative";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

// Gemini prompt
async function callGemini(prompt) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1/models/${G_MODEL}:generateContent?key=${G_KEY}`;
  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }]
  };
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(() => ({}));
  return { r, data };
}

// Leonardo image
async function callLeonardo(prompt) {
  const endpoint = "https://cloud.leonardo.ai/api/rest/v1/generations";
  const payload = {
    prompt,
    modelId: L_MODEL,
    width: 768,
    height: 1024,
    num_images: 1
  };

  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${L_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await r.json().catch(() => ({}));
  return { r, data };
}

async function handlePrompt(req, res, body) {
  try {
    const { style, shape, purpose, decorations = [] } =
      JSON.parse(body || "{}");

    const p =
`Short photorealistic nail-art image prompt.
Style: ${style}; Shape: ${shape}; Purpose: ${purpose};
Decorations: ${decorations.join(", ")}.
Studio background, soft natural light.`;

    const { r, data } = await callGemini(p);
    if (!r.ok) {
      return send(res, r.status, { error: "gemini_error", details: data });
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return send(res, 500, { error: "no_prompt" });

    return send(res, 200, { prompt: text, modelUsed: G_MODEL });
  } catch (e) {
    return send(res, 500, { error: "exception", details: String(e) });
  }
}

async function handleImage(req, res, body) {
  try {
    if (!L_KEY) return send(res, 500, { error: "missing_LEONARDO_KEY" });

    const { prompt } = JSON.parse(body || "{}");

    const { r, data } = await callLeonardo(prompt);

    if (!r.ok) {
      return send(res, r.status, { error: "leonardo_error", details: data });
    }

    const url = data?.generations?.[0]?.generated_images?.[0]?.url;
    if (!url) return send(res, 500, { error: "no_image" });

    return send(res, 200, {
      imageUrl: url,
      provider: "leonardo",
      modelUsed: L_MODEL
    });

  } catch (e) {
    return send(res, 500, { error: "exception", details: String(e) });
  }
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/health")) {
    return send(res, 200, {
      ok: true,
      promptModel: G_MODEL,
      imageModel: L_MODEL
    });
  }

  if (req.method === "POST" && u.pathname === "/prompt") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handlePrompt(req, res, body));
    return;
  }

  if (req.method === "POST" && u.pathname === "/image") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handleImage(req, res, body));
    return;
  }

  return send(res, 404, { error: "not_found" });
});

server.listen(PORT, () =>
  console.log("NailAI Leonardo Proxy running on", PORT)
);
// --- Leonardo Key Test ---
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
