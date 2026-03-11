const http = require("http");
const url = require("url");

const PORT  = process.env.PORT || 10000;
const KEY   = process.env.GOOGLE_AI_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

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

async function handlePrompt(req, res, body) {
  try {
    const { style, shape, purpose, decorations = [] } = JSON.parse(body || "{}");

    const prompt =
`Short photorealistic nail-art image prompt (<=160 chars).
Style: ${style}; Shape: ${shape}; Purpose: ${purpose}; Decorations: ${decorations.join(", ")}.
Studio background, soft light.`;

    // 🔹 v1 schema requires role: 'user'
    const payload = {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ]
    };

    const endpoint = `https://generativelanguage.googleapis.com/v1/models/${MODEL}:generateContent?key=${KEY}`;

    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));

    // 🔹 לוגים לדיאגנוסטיקה ב-Render
    console.log("[Gemini] status:", r.status, "model:", MODEL);
    if (r.status !== 200) {
      console.log("[Gemini] error body:", JSON.stringify(data));
    }

    if (!r.ok) {
      // מחזירים ללקוח את הסטטוס המקורי (401/403/429/400…)
      return send(res, r.status, { error: "gemini_api_error", details: data });
    }

    const text = (data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    return send(res, 200, { prompt: text });

  } catch (e) {
    console.log("[Server] exception:", e);
    return send(res, 500, { error: "server_error", details: String(e) });
  }
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);

  // Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  // Health
  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/health")) {
    return send(res, 200, { ok: true, model: MODEL });
  }

  // Prompt
  if (req.method === "POST" && u.pathname === "/prompt") {
    let body = "";
    req.on("data", ch => (body += ch));
    req.on("end", () => handlePrompt(req, res, body));
    return;
  }

  send(res, 404, { error: "not_found" });
});

server.listen(PORT, () => console.log("NailAI proxy listening on", PORT));
