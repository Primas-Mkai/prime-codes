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
const MODELS = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
const MAX_ROUNDS = 2; // if every model fails with a retryable error, wait and go through the list once more
const ROUND_PAUSE_MS = 1500;
const AI_ATTEMPT_TIMEOUT_MS = Number(process.env.AI_ATTEMPT_TIMEOUT_MS) || 12000;
const AI_TOTAL_TIMEOUT_MS = Number(process.env.AI_TOTAL_TIMEOUT_MS) || 25000;

// Limits so a stranger can't send huge requests and burn through your free quota.
const MAX_MESSAGE_LENGTH = 500;
const MAX_HISTORY_MESSAGES = 10;
const MAX_BODY_BYTES = 20 * 1024;

// Origins (besides the server's own) whose browser pages may call /api/chat.
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5500,http://127.0.0.1:5500"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Rate limits (in memory, reset when the server restarts).
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 20;
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 10 * 60 * 1000;
const GLOBAL_LIMIT_MAX = Number(process.env.GLOBAL_LIMIT_MAX) || 300;
const GLOBAL_LIMIT_WINDOW_MS = Number(process.env.GLOBAL_LIMIT_WINDOW_MS) || 60 * 60 * 1000;
const MAX_TRACKED_IPS = 10000;

// --- businesses: one folder each, loaded once at startup ---------------------
// businesses/<id>/info.txt (system prompt text) and businesses/<id>/config.json.
const DEFAULT_BUSINESS = "daily-grind";
const BUSINESSES_DIR = path.join(__dirname, "businesses");

function loadBusinesses() {
  const loaded = {};
  for (const entry of fs.readdirSync(BUSINESSES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const infoPath = path.join(BUSINESSES_DIR, id, "info.txt");
    const configPath = path.join(BUSINESSES_DIR, id, "config.json");
    if (!fs.existsSync(infoPath) || !fs.existsSync(configPath)) {
      throw new Error(`Business folder "${id}" must contain info.txt and config.json`);
    }
    const info = fs.readFileSync(infoPath, "utf8");
    if (!info.trim()) throw new Error(`Business folder "${id}" has an empty info.txt`);
    loaded[id] = { info, config: JSON.parse(fs.readFileSync(configPath, "utf8")) };
  }
  return loaded;
}

let BUSINESSES;
try {
  BUSINESSES = loadBusinesses();
} catch (err) {
  console.error("Startup error:", err.message);
  process.exit(1);
}

const CONTENT_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
};

function sendJson(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
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
    const headers = { "Content-Type": CONTENT_TYPES[ext] || "text/plain" };
    // The embeddable widget must always be re-checked so updates reach every site quickly.
    if (pathname === "/widget.js") headers["Cache-Control"] = "no-cache";
    res.writeHead(200, headers);
    res.end(data);
  });
}

// --- calling Gemini, with fallback ------------------------------------------
async function askGemini(messages) {
  const startedAt = Date.now();
  const timeLeft = () => AI_TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
  let lastError;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    for (const model of MODELS) {
      if (timeLeft() <= 0) throw new Error(`AI provider failed (out of time, last status ${lastError})`);

      let response, data;
      try {
        response = await fetch(GEMINI_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.GEMINI_API_KEY}`,
          },
          body: JSON.stringify({ model, messages }),
          signal: AbortSignal.timeout(Math.min(AI_ATTEMPT_TIMEOUT_MS, timeLeft())),
        });
        data = await response.json();
      } catch (err) {
        // A timeout or network error: try the next model.
        console.error(`Gemini error (${model}):`, err.name);
        lastError = err.name;
        continue;
      }

      if (response.ok) {
        if (model !== MODELS[0]) console.log(`Fallback model used: ${model}`);
        return data.choices[0].message.content;
      }

      console.error(`Gemini error (${model}):`, response.status, JSON.stringify(data));
      lastError = response.status;
      // Only 503 (overloaded) and 429 (rate limit) are worth trying another model for.
      if (response.status !== 503 && response.status !== 429) throw new Error(`AI provider failed (last status ${lastError})`);
    }

    // Every model failed with a retryable error: pause, then go through the list once more.
    if (round < MAX_ROUNDS && timeLeft() > ROUND_PAUSE_MS) {
      console.log("All models busy, retrying in 1.5s");
      await new Promise((resolve) => setTimeout(resolve, ROUND_PAUSE_MS));
    } else {
      break;
    }
  }
  throw new Error(`AI provider failed (last status ${lastError})`);
}

// --- CORS ---------------------------------------------------------------------
// CORS only protects browsers: curl or another server can ignore it completely.
// That is why the rate limit below exists too.
// Returns the CORS headers to add (empty object = none needed), or null if the origin is blocked.
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return {}; // curl / server-to-server
  const host = req.headers.host;
  if (host && (origin === `http://${host}` || origin === `https://${host}`)) return {}; // our own page
  if (ALLOWED_ORIGINS.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };
  }
  return null;
}

// --- rate limiting ----------------------------------------------------------
// Fixed windows, in memory only.
const ipHits = new Map(); // ip -> { count, resetAt }
let globalHits = { count: 0, resetAt: 0 };

// Behind Render's proxy the real visitor address is the first entry of X-Forwarded-For.
// A determined attacker can fake this header to look like many visitors, which is why
// the global cap exists as well.
function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const first = forwarded.split(",")[0].trim().slice(0, 64);
    if (first) return first;
  }
  return req.socket.remoteAddress || "unknown";
}

// Returns 0 if the request is allowed, otherwise the number of seconds to wait.
function checkRateLimit(ip) {
  const now = Date.now();

  // Per-visitor check first: a blocked visitor must not use up the server-wide allowance.
  if (ipHits.size > MAX_TRACKED_IPS) ipHits.clear();
  let entry = ipHits.get(ip);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    ipHits.set(ip, entry);
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) return Math.ceil((entry.resetAt - now) / 1000);

  // Only requests that passed the per-visitor check count toward the global cap.
  if (now >= globalHits.resetAt) globalHits = { count: 0, resetAt: now + GLOBAL_LIMIT_WINDOW_MS };
  globalHits.count++;
  if (globalHits.count > GLOBAL_LIMIT_MAX) return Math.ceil((globalHits.resetAt - now) / 1000);
  return 0;
}

// Remove expired entries every 5 minutes (unref so this timer never keeps the server alive).
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipHits) if (now >= entry.resetAt) ipHits.delete(ip);
}, 5 * 60 * 1000).unref();

// --- the /api/chat endpoint -------------------------------------------------
function handleChat(req, res, corsHeaders) {
  const retryAfter = checkRateLimit(clientIp(req));
  if (retryAfter) {
    req.resume();
    return sendJson(
      res,
      429,
      { error: "Too many messages right now. Please wait a few minutes and try again." },
      { ...corsHeaders, "Retry-After": String(retryAfter) }
    );
  }

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

    let userMessage, history, businessId;
    try {
      const parsed = JSON.parse(body);
      userMessage = parsed.message;
      history = Array.isArray(parsed.history) ? parsed.history : [];
      businessId = typeof parsed.business === "string" && parsed.business ? parsed.business : DEFAULT_BUSINESS;
    } catch (err) {
      return sendJson(res, 400, { error: "Invalid request body" }, corsHeaders);
    }

    if (typeof userMessage !== "string" || !userMessage.trim()) {
      return sendJson(res, 400, { error: "Missing 'message'" }, corsHeaders);
    }
    if (userMessage.length > MAX_MESSAGE_LENGTH) {
      return sendJson(res, 400, { error: `Message too long (max ${MAX_MESSAGE_LENGTH} characters)` }, corsHeaders);
    }

    // The id is only ever used as a key into the in-memory object, never to build a path.
    if (!Object.prototype.hasOwnProperty.call(BUSINESSES, businessId)) {
      return sendJson(res, 400, { error: "Unknown business." }, corsHeaders);
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
        { role: "system", content: BUSINESSES[businessId].info },
        ...safeHistory,
        { role: "user", content: userMessage },
      ]);
      sendJson(res, 200, { reply }, corsHeaders);
    } catch (err) {
      console.error("Chat failed:", err.message);
      const contact = BUSINESSES[businessId].config.fallbackContact || "contact the business directly";
      sendJson(
        res,
        502,
        { error: `The assistant is busy right now. Please try again in a moment, or ${contact}.` },
        corsHeaders
      );
    }
  });
}

// --- GET /api/config: the public, whitelisted settings the widget needs ----------
const DEFAULT_THEME = { primary: "#1F4A3A", accent: "#C9A15A", primaryText: "#FFFFFF", accentText: "#1C1B19" };

function safeColor(value, fallback) {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

function safeText(value, max, fallback) {
  return typeof value === "string" && value.trim() ? value.slice(0, max) : fallback;
}

// Built fresh from whitelisted fields only (never send fallbackContact or anything else).
function buildPublicConfig(config) {
  const name = safeText(config.name, 80, "Assistant");
  const theme = config.theme && typeof config.theme === "object" ? config.theme : {};
  return {
    name,
    assistantName: safeText(config.assistantName, 80, name + " assistant"),
    greeting: safeText(config.greeting, 300, ""),
    buttonLabel: safeText(config.buttonLabel, 40, "Ask us anything"),
    theme: {
      primary: safeColor(theme.primary, DEFAULT_THEME.primary),
      accent: safeColor(theme.accent, DEFAULT_THEME.accent),
      primaryText: safeColor(theme.primaryText, DEFAULT_THEME.primaryText),
      accentText: safeColor(theme.accentText, DEFAULT_THEME.accentText),
    },
  };
}

function handleConfig(req, res) {
  const corsHeaders = checkOrigin(req);
  if (!corsHeaders) return sendJson(res, 403, { error: "Origin not allowed." });

  const requestedId = new URL(req.url, "http://localhost").searchParams.get("business");
  const businessId = requestedId ? requestedId : DEFAULT_BUSINESS;
  // The id is only ever used as a key into the in-memory object, never to build a path.
  if (!Object.prototype.hasOwnProperty.call(BUSINESSES, businessId)) {
    return sendJson(res, 404, { error: "Unknown business." });
  }

  const headers = { "Cache-Control": "public, max-age=300" };
  if (corsHeaders["Access-Control-Allow-Origin"]) {
    headers["Access-Control-Allow-Origin"] = corsHeaders["Access-Control-Allow-Origin"];
    headers.Vary = "Origin";
  }
  sendJson(res, 200, buildPublicConfig(BUSINESSES[businessId].config), headers);
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];
  if (pathname === "/api/chat" && (req.method === "POST" || req.method === "OPTIONS")) {
    const corsHeaders = checkOrigin(req);
    if (!corsHeaders) {
      req.resume();
      return sendJson(res, 403, { error: "Origin not allowed." });
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }
    handleChat(req, res, corsHeaders);
    return;
  }
  if (req.method === "GET" && pathname === "/api/config") {
    handleConfig(req, res);
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