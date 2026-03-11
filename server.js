const http = require("http");
const url = require("url");

const PORT  = process.env.PORT || 10000;
const KEY   = process.env.GOOGLE_AI_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

// כותרות CORS לשימוש בכל תשובה
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

async function handlePrompt(req, res, body) {
  try {
    const { style, shape, purpose, decorations = [] } = JSON.parse(body || "{}");

    const prompt = `Short photorealistic nail-art image prompt (<=160 chars).
Style: ${style}; Shape: ${shape}; Purpose: ${purpose}; Decorations: ${decorations.join(", ")}.
Studio background, soft light.`;

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/${MODEL}:generateContent?key=${KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );

    const data = await r.json();
    const text = (data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();

    res.writeHead(r.ok ? 200 : 502, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify(r.ok ? { prompt: text } : { error: "gemini_api_error", details: data }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify({ error: "server_error", details: String(e) }));
  }
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);

  // טיפול ב‑preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  // בריאות
  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS });
    return res.end(JSON.stringify({ ok: true, model: MODEL }));
  }

  // יצירת prompt
  if (req.method === "POST" && u.pathname === "/prompt") {
    let body = "";
    req.on("data", ch => (body += ch));
    req.on("end", () => handlePrompt(req, res, body));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain", ...CORS_HEADERS });
  res.end("Not found");
});

server.listen(PORT, () => console.log("NailAI proxy listening on", PORT));
