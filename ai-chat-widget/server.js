const http = require("http");
const fs = require("fs");
const path = require("path");

// --- tiny .env loader (reads .env into process.env, no installs needed) ---
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    // Don't overwrite values already set by the hosting platform.
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(path.join(__dirname, ".env"));

// --- settings ---------------------------------------------------------------
const PORT = process.env.PORT || 3000; // hosting platforms choose the port for you
const PUBLIC_DIR = path.join(__dirname, "public"); // the ONLY folder visitors can read from
const GEMINI_URL =
  process.env.GEMINI_URL ||
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

// Models are tried in order. If the first is overloaded (503) or rate-limited
// (429), we automatically fall back to the next one.
const MODELS = ["gemini-3.6-flash", "gemini-3.5-flash"];

// Limits so a stranger can't send huge requests and burn through your free quota.
const MAX_MESSAGE_LENGTH = 500;
const MAX_HISTORY_MESSAGES = 10;
const MAX_BODY_BYTES = 20 * 1024;

const SYSTEM_PROMPT = `You are a friendly assistant for "The Daily Grind Coffee Shop."

Hours: Mon-Fri 7am-6pm, Sat 8am-5pm, Sun 8am-2pm
Location: 142 Market Street, Springfield
Phone: (555) 123-4567

Menu highlights:
- Pour-over coffee: $4.50
- Cappuccino: $4.00
- Cold brew: $4.75
- Croissant: $3.25
- Avocado toast: $7.50

Services: dine-in and takeaway, free wifi, small private event space (ask for pricing), vegan/dairy-free milk options available.

Rules:
- Only answer using the facts above. Never invent hours, prices, or menu items.
- Keep answers short and conversational (2-4 sentences).
- You may remember and refer back to things the visitor told you earlier in this conversation (like their name).
- If asked something unrelated to this business, or something not covered above, politely say you can't help with that here and point them to the phone number instead of guessing.`;

const CONTENT_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
};

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// --- serving the website files ----------------------------------------------
function serveStaticFile(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch (err) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.join(PUBLIC_DIR, requested);

  // Security: refuse anything that resolves outside the public folder
  // (e.g. "/../server.js" or "/../.env").
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] || "text/plain" });
    res.end(data);
  });
}

// --- calling Gemini, with fallback ------------------------------------------
async function askGemini(messages) {
  let lastError;
  for (const model of MODELS) {
    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GEMINI_API_KEY}`,
      },
      body: JSON.stringify({ model, messages }),
    });
    const data = await response.json();

    if (response.ok) return data.choices[0].message.content;

    console.error(`Gemini error (${model}):`, response.status, JSON.stringify(data));
    lastError = response.status;
    // Only 503 (overloaded) and 429 (rate limit) are worth trying another model for.
    if (response.status !== 503 && response.status !== 429) break;
  }
  throw new Error(`AI provider failed (last status ${lastError})`);
}

// --- the /api/chat endpoint -------------------------------------------------
function handleChat(req, res) {
  let body = "";
  let tooLarge = false;

  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      tooLarge = true;
      req.destroy();
    }
  });

  req.on("end", async () => {
    if (tooLarge) return;

    let userMessage, history;
    try {
      const parsed = JSON.parse(body);
      userMessage = parsed.message;
      history = Array.isArray(parsed.history) ? parsed.history : [];
    } catch (err) {
      return sendJson(res, 400, { error: "Invalid request body" });
    }

    if (typeof userMessage !== "string" || !userMessage.trim()) {
      return sendJson(res, 400, { error: "Missing 'message'" });
    }
    if (userMessage.length > MAX_MESSAGE_LENGTH) {
      return sendJson(res, 400, { error: `Message too long (max ${MAX_MESSAGE_LENGTH} characters)` });
    }

    // Only accept well-formed user/assistant turns, and keep just the most recent ones.
    // (Never trust the browser to send safe data - it could send anything, including a fake "system" message.)
    const safeHistory = history
      .filter(
        (m) =>
          m &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          m.content.length <= 2000
      )
      .slice(-MAX_HISTORY_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      const reply = await askGemini([
        { role: "system", content: SYSTEM_PROMPT },
        ...safeHistory,
        { role: "user", content: userMessage },
      ]);
      sendJson(res, 200, { reply });
    } catch (err) {
      console.error("Chat failed:", err.message);
      sendJson(res, 502, {
        error: "The assistant is busy right now. Please try again in a moment, or call us at (555) 123-4567.",
      });
    }
  });
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];
  if (req.method === "POST" && pathname === "/api/chat") {
    handleChat(req, res);
    return;
  }
  if (req.method === "GET") {
    serveStaticFile(req, res);
    return;
  }
  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});