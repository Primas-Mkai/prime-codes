const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { validateLead } = require("./lead-validation");
const { deliverLead } = require("./lead-delivery");

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

// Lead form limits (POST /api/lead): stricter, because each lead may become an email.
const LEAD_RATE_LIMIT_MAX = Number(process.env.LEAD_RATE_LIMIT_MAX) || 3;
const LEAD_RATE_LIMIT_WINDOW_MS = Number(process.env.LEAD_RATE_LIMIT_WINDOW_MS) || 60 * 60 * 1000;
const LEAD_GLOBAL_LIMIT_MAX = Number(process.env.LEAD_GLOBAL_LIMIT_MAX) || 50;
const LEAD_GLOBAL_LIMIT_WINDOW_MS = Number(process.env.LEAD_GLOBAL_LIMIT_WINDOW_MS) || 60 * 60 * 1000;

// --- businesses: one folder each, loaded once at startup ---------------------
// businesses/<id>/info.txt (system prompt text) and businesses/<id>/config.json.
const DEFAULT_BUSINESS = "daily-grind";
const BUSINESSES_DIR = path.join(__dirname, "businesses");

// Returns { interests } when the business has lead capture switched on (with a usable interests list), else null.
function getLeadConfig(config) {
  const lc = config && config.leadCapture;
  if (!lc || lc.enabled !== true || !Array.isArray(lc.interests)) return null;
  const interests = lc.interests.filter((i) => typeof i === "string" && i.trim()).map((i) => i.trim());
  if (!interests.length) return null;
  // Optional short note the widget shows after a successful send: 1 to 120 characters once cleaned.
  const note = typeof lc.successNote === "string" ? lc.successNote.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").replace(/ {2,}/g, " ").trim() : "";
  return { interests, ...(note.length >= 1 && note.length <= 120 && { successNote: note }) };
}

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
    // Lead capture is opt-in: only businesses with leadCapture.enabled get the tool and /api/lead.
    loaded[id].lead = getLeadConfig(loaded[id].config);
    // "document" businesses also load document.txt (a missing mode means a normal "chat" business).
    if (loaded[id].config.mode === "document") loaded[id].doc = loadDocument(id);
  }
  return loaded;
}

// --- document mode: the handbook text, its headings and a normalised copy for matching ---
const MAX_DOCUMENT_BYTES = 200 * 1024;
const HEADING_RE = /^#{1,3}\s+(\d+(?:\.\d+)?\.?\s+.+)$/;
const MIN_QUOTE_CHARS = 8; // a tiny "quote" would match almost anywhere
const MAX_QUOTE_CHARS = 400; // the model is told 300; allow some slack for normalisation

// Lower-case, straighten curly quotes, drop markdown characters (* _ ` # |) and leading "- "
// list markers, and collapse all whitespace to single spaces. Returns the normalised text and,
// for every normalised character, the index of the original character it came from.
function normaliseWithMap(text) {
  let out = "";
  const map = [];
  let atLineStart = true;
  for (let i = 0; i < text.length; i++) {
    let c = text[i];
    if (c === "\n") {
      atLineStart = true;
    } else if (!/\s/.test(c)) {
      if (atLineStart && c === "-" && /\s/.test(text[i + 1] || "")) continue; // "- " list marker
      atLineStart = false;
    }
    if ("*_`#|".includes(c)) continue;
    if (c === "\u2018" || c === "\u2019" || c === "\u201B") c = "'";
    else if (c === "\u201C" || c === "\u201D") c = '"';
    if (/\s/.test(c)) {
      if (out === "" || out[out.length - 1] === " ") continue;
      out += " ";
      map.push(i);
      continue;
    }
    for (const lower of c.toLowerCase()) {
      out += lower;
      map.push(i);
    }
  }
  if (out.endsWith(" ")) {
    out = out.slice(0, -1);
    map.pop();
  }
  return { text: out, map };
}

function normalise(text) {
  return normaliseWithMap(String(text)).text;
}

function loadDocument(id) {
  const docPath = path.join(BUSINESSES_DIR, id, "document.txt");
  try {
    if (!fs.existsSync(docPath)) {
      console.warn(`Warning: business "${id}" is in document mode but has no document.txt; /api/ask-document is unavailable for it.`);
      return null;
    }
    if (fs.statSync(docPath).size > MAX_DOCUMENT_BYTES) {
      console.warn(`Warning: document.txt of "${id}" is larger than ${MAX_DOCUMENT_BYTES / 1024} KB and was not loaded.`);
      return null;
    }
    const text = fs.readFileSync(docPath, "utf8").replace(/\r\n/g, "\n");
    if (!text.trim()) {
      console.warn(`Warning: document.txt of "${id}" is empty and was not loaded.`);
      return null;
    }
    const headings = [];
    let offset = 0;
    for (const line of text.split("\n")) {
      const m = HEADING_RE.exec(line);
      if (m) headings.push({ offset, text: m[1].trim() });
      offset += line.length + 1;
    }
    return { text, headings, norm: normaliseWithMap(text) };
  } catch (err) {
    console.warn(`Warning: could not load document.txt of "${id}": ${err.message}`);
    return null;
  }
}

// Display-only tidy-up of a verified quote: no markdown, table rows shown as "cell \u00B7 cell".
function cleanQuote(raw) {
  let text = raw.replace(/[*_`]/g, "").replace(/^[ \t]*(?:-[ \t]+|#+[ \t]*)/gm, "");
  if (text.includes("|")) {
    text = text
      .split("|")
      .map((cell) => cell.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" \u00B7 ");
  }
  return text.replace(/\s+/g, " ").trim();
}

// Checks that the quote really exists in the document. Returns { section, quote } (the quote as
// written in the ORIGINAL document, and the nearest heading before it), or null if not found.
function verifyQuote(business, quote) {
  const doc = business && business.doc;
  if (!doc || typeof quote !== "string") return null;
  const q = normalise(quote);
  if (q.length < MIN_QUOTE_CHARS || q.length > MAX_QUOTE_CHARS) return null;
  const at = doc.norm.text.indexOf(q);
  if (at === -1) return null;
  const start = doc.norm.map[at];
  const end = doc.norm.map[at + q.length - 1] + 1;
  let section = "";
  for (const h of doc.headings) {
    if (h.offset <= start) section = h.text;
    else break;
  }
  return { section, quote: cleanQuote(doc.text.slice(start, end)) };
}

// Tests can replace these with fakes; nothing in production touches them.
const hooks = { askGemini, deliverLead };

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

  // A path ending in "/" means that folder's index.html ("/" itself is public/index.html).
  const requested = pathname.endsWith("/") ? pathname.slice(1) + "index.html" : pathname.slice(1);
  const filePath = path.join(PUBLIC_DIR, requested);

  // Security: refuse anything that resolves outside the public folder
  // (e.g. "/../server.js" or "/../.env").
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  // A folder without the trailing slash (e.g. "/handbook"): redirect so relative links work.
  if (!pathname.endsWith("/")) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      stat = null;
    }
    if (stat && stat.isDirectory()) {
      const url = new URL(req.url, "http://localhost");
      res.writeHead(301, { Location: url.pathname + "/" + url.search });
      res.end();
      return;
    }
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
// options (all optional): temperature, jsonMode (ask for a JSON object), meta (receives { model }),
// tools + toolChoice (function calling), returnMessage (return the whole message instead of just its text),
// deadline (epoch ms by which the whole call must be finished, so several calls can share one time budget).
async function askGemini(messages, options = {}) {
  const startedAt = Date.now();
  const timeLeft = () =>
    Math.min(
      AI_TOTAL_TIMEOUT_MS - (Date.now() - startedAt),
      options.deadline !== undefined ? options.deadline - Date.now() : Infinity
    );
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
          body: JSON.stringify({
            model,
            messages,
            ...(options.temperature !== undefined && { temperature: options.temperature }),
            ...(options.jsonMode && { response_format: { type: "json_object" } }),
            ...(options.tools && { tools: options.tools, tool_choice: options.toolChoice || "auto" }),
          }),
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
        if (options.meta) options.meta.model = model;
        return options.returnMessage ? data.choices[0].message : data.choices[0].message.content;
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

const limiters = [];

// A per-visitor limit plus a global cap. check(ip) returns 0 if the request is allowed,
// otherwise the number of seconds to wait.
function makeRateLimiter({ perMax, perWindowMs, globalMax, globalWindowMs }) {
  const ipHits = new Map(); // ip -> { count, resetAt }
  let globalHits = { count: 0, resetAt: 0 };
  const limiter = {
    check(ip) {
      const now = Date.now();

      // Per-visitor check first: a blocked visitor must not use up the server-wide allowance.
      if (ipHits.size > MAX_TRACKED_IPS) ipHits.clear();
      let entry = ipHits.get(ip);
      if (!entry || now >= entry.resetAt) {
        entry = { count: 0, resetAt: now + perWindowMs };
        ipHits.set(ip, entry);
      }
      entry.count++;
      if (entry.count > perMax) return Math.ceil((entry.resetAt - now) / 1000);

      // Only requests that passed the per-visitor check count toward the global cap.
      if (now >= globalHits.resetAt) globalHits = { count: 0, resetAt: now + globalWindowMs };
      globalHits.count++;
      if (globalHits.count > globalMax) return Math.ceil((globalHits.resetAt - now) / 1000);
      return 0;
    },
    cleanup(now) {
      for (const [ip, entry] of ipHits) if (now >= entry.resetAt) ipHits.delete(ip);
    },
  };
  limiters.push(limiter);
  return limiter;
}

const chatLimiter = makeRateLimiter({
  perMax: RATE_LIMIT_MAX,
  perWindowMs: RATE_LIMIT_WINDOW_MS,
  globalMax: GLOBAL_LIMIT_MAX,
  globalWindowMs: GLOBAL_LIMIT_WINDOW_MS,
});
const leadLimiter = makeRateLimiter({
  perMax: LEAD_RATE_LIMIT_MAX,
  perWindowMs: LEAD_RATE_LIMIT_WINDOW_MS,
  globalMax: LEAD_GLOBAL_LIMIT_MAX,
  globalWindowMs: LEAD_GLOBAL_LIMIT_WINDOW_MS,
});

// Used by /api/chat and /api/ask-document.
function checkRateLimit(ip) {
  return chatLimiter.check(ip);
}

// Remove expired entries every 5 minutes (unref so this timer never keeps the server alive).
setInterval(() => {
  const now = Date.now();
  for (const limiter of limiters) limiter.cleanup(now);
}, 5 * 60 * 1000).unref();

// --- lead capture: the propose_lead tool used by /api/chat ----------------------
const LEAD_TOOL_NAME = "propose_lead";
const LEAD_CONFIRM_REPLY =
  "Please check the details below and press Send. / Tafadhali hakiki taarifa hapa chini kisha bonyeza Tuma.";
const LEAD_PROMPT_SUFFIX =
  "\n\nLead capture rule: when the visitor has given their name, a contact (email or phone) and their interest, call the " +
  LEAD_TOOL_NAME +
  " tool. Do not say or imply that the details have been sent: the visitor must confirm first, by pressing the Send button that appears under your message.";

function buildLeadTool(interests) {
  return {
    type: "function",
    function: {
      name: LEAD_TOOL_NAME,
      description:
        "Call this only when the visitor has actually given, in this conversation, their name, at least one contact (email or phone) and what they are interested in. Never invent or guess values. Calling it only shows the visitor a summary to confirm; it sends nothing.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The visitor's full name." },
          email: { type: "string", description: "The visitor's email address, exactly as they typed it." },
          phone: { type: "string", description: "The visitor's phone number, exactly as they typed it." },
          company: { type: "string", description: "The visitor's company name." },
          interest: { type: "string", enum: interests, description: "What the visitor is interested in." },
          message: { type: "string", description: "A short message from the visitor." },
        },
        required: ["name", "interest"],
      },
    },
  };
}

// Looks at a model message. Returns { reply } for plain text, { reply, lead } for a valid proposal, or
// { invalid: { field, reason }, toolCall } when the proposal must be corrected.
function readLeadMessage(message, interests, visitorMessages) {
  const call = Array.isArray(message.tool_calls)
    ? message.tool_calls.find((c) => c && c.function && c.function.name === LEAD_TOOL_NAME)
    : null;
  const text = typeof message.content === "string" ? message.content.trim() : "";
  if (!call) {
    if (!text) throw new Error("model gave no text");
    return { reply: text };
  }
  // The arguments should be a JSON string; an object is accepted too. Anything unreadable is a failed proposal.
  let args = null;
  const rawArguments = call.function.arguments;
  if (typeof rawArguments === "string") {
    try {
      args = JSON.parse(rawArguments);
    } catch (err) {
      args = null; // invalid JSON: a failed proposal
    }
  } else if (rawArguments && typeof rawArguments === "object") {
    args = rawArguments;
  }
  const result = args
    ? validateLead(args, interests, { visitorMessages })
    : { ok: false, field: "details", reason: "could not be read; please send them again." };
  if (result.ok) return { reply: text || LEAD_CONFIRM_REPLY, lead: result.lead };
  return { invalid: { field: result.field, reason: result.reason }, toolCall: call, text };
}

// Chat for a lead-capture business. A valid proposal is returned as "lead" for the visitor to confirm.
// An invalid one is never shown: the model gets ONE extra round (a tool result describing the problem) to
// ask the visitor for a correction. All model calls share one time budget (AI_TOTAL_TIMEOUT_MS).
async function chatWithLeadCapture(business, messages, visitorMessages, meta) {
  const interests = business.lead.interests;
  const deadline = Date.now() + AI_TOTAL_TIMEOUT_MS;
  const options = { tools: [buildLeadTool(interests)], toolChoice: "auto", returnMessage: true, meta, deadline };
  const withSuffix = [{ role: "system", content: messages[0].content + LEAD_PROMPT_SUFFIX }, ...messages.slice(1)];

  const first = readLeadMessage(await hooks.askGemini(withSuffix, options), interests, visitorMessages);
  if (!first.invalid) return first;

  // The model's tool call may come back without a usable id (missing, empty or not a string). Rebuild the
  // entry from scratch (never mutating the model's object) and use one id for both the assistant message
  // and the tool result, so the follow-up request is always well-formed.
  const modelCall = first.toolCall;
  const callId =
    typeof modelCall.id === "string" && modelCall.id.trim() ? modelCall.id : "call_" + crypto.randomBytes(8).toString("hex");
  const rawArgs = modelCall.function.arguments;
  const toolCall = {
    id: callId,
    type: "function",
    function: {
      name: LEAD_TOOL_NAME,
      // Always a string: the model's own string, else its object as JSON, else "{}".
      arguments: typeof rawArgs === "string" ? rawArgs : rawArgs && typeof rawArgs === "object" ? JSON.stringify(rawArgs) : "{}",
    },
  };

  const followUp = [
    ...withSuffix,
    { role: "assistant", content: first.text || null, tool_calls: [toolCall] },
    {
      role: "tool",
      tool_call_id: callId,
      name: LEAD_TOOL_NAME,
      content: JSON.stringify({ error: first.invalid.field + " " + first.invalid.reason }),
    },
  ];
  const second = readLeadMessage(await hooks.askGemini(followUp, options), interests, visitorMessages);
  if (second.invalid) throw new Error("lead proposal still invalid after one correction round");
  return second;
}

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
    // Document businesses are answered by /api/ask-document, never by plain chat.
    if (BUSINESSES[businessId].config.mode === "document") {
      return sendJson(
        res,
        400,
        { error: "This assistant answers from a document. Please use the document question box." },
        corsHeaders
      );
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
      const messages = [
        { role: "system", content: BUSINESSES[businessId].info },
        ...safeHistory,
        { role: "user", content: userMessage },
      ];
      if (BUSINESSES[businessId].lead) {
        // Only the visitor's own messages count when checking that a contact detail was really typed by them.
        const visitorMessages = [...safeHistory.filter((m) => m.role === "user").map((m) => m.content), userMessage];
        const meta = {};
        const result = await chatWithLeadCapture(BUSINESSES[businessId], messages, visitorMessages, meta);
        console.log(`chat business=${businessId} lead_proposal=${result.lead ? "shown" : "none"} model=${meta.model || "-"}`);
        return sendJson(res, 200, result, corsHeaders);
      }
      const reply = await hooks.askGemini(messages);
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

// --- POST /api/ask-document: answer from the business's document, with a verified quote ---

// Tolerant parsing: strip ``` fences if present, then JSON.parse. Returns a valid object or null.
function parseModelAnswer(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.found !== "boolean") return null;
  if (typeof parsed.answer !== "string" || !parsed.answer.trim()) return null;
  if (parsed.found && typeof parsed.quote !== "string") return null;
  return { found: parsed.found, answer: parsed.answer.trim().slice(0, 1500), quote: parsed.quote || "" };
}

// Asks the model (at most twice) and returns the response object for the visitor.
async function answerFromDocument(business, question, meta) {
  const messages = [
    { role: "system", content: `${business.info}\n\nDOCUMENT START\n${business.doc.text}\nDOCUMENT END` },
    { role: "user", content: question },
  ];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const parsed = parseModelAnswer(
      await hooks.askGemini(messages, { temperature: 0.1, jsonMode: true, meta })
    );
    if (!parsed) continue; // unreadable reply: counts as a failed attempt
    if (!parsed.found) return { found: false, answer: parsed.answer, source: null };
    const verified = verifyQuote(business, parsed.quote);
    if (verified) return { found: true, answer: parsed.answer, source: verified };
  }
  const contact = business.config.fallbackContact || "contact the business directly";
  return {
    found: false,
    answer: `I could not confirm that from the handbook, so I would rather not guess. Please ${contact}.`,
    source: null,
    verified: false,
  };
}

function handleAskDocument(req, res, corsHeaders) {
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
    if (tooLarge) return;
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      tooLarge = true;
      body = "";
      res.on("finish", () => req.destroy());
      sendJson(res, 413, { error: "Request too large." }, { ...corsHeaders, Connection: "close" });
    }
  });

  req.on("end", async () => {
    if (tooLarge) return;

    let businessId, question;
    try {
      const parsed = JSON.parse(body);
      businessId = typeof parsed.business === "string" && parsed.business ? parsed.business : DEFAULT_BUSINESS;
      question = parsed.question;
    } catch (err) {
      return sendJson(res, 400, { error: "Invalid request body" }, corsHeaders);
    }
    // The id is only ever used as a key into the in-memory object, never to build a path.
    if (!Object.prototype.hasOwnProperty.call(BUSINESSES, businessId)) {
      return sendJson(res, 400, { error: "Unknown business." }, corsHeaders);
    }
    const business = BUSINESSES[businessId];
    if (business.config.mode !== "document" || !business.doc) {
      return sendJson(res, 400, { error: "This assistant does not answer questions from a document." }, corsHeaders);
    }
    if (typeof question !== "string" || !question.trim()) {
      return sendJson(res, 400, { error: "Please type a question." }, corsHeaders);
    }
    question = question.trim();
    if (question.length > MAX_MESSAGE_LENGTH) {
      return sendJson(res, 400, { error: `Question too long (max ${MAX_MESSAGE_LENGTH} characters)` }, corsHeaders);
    }

    const startedAt = Date.now();
    const meta = {};
    try {
      const result = await answerFromDocument(business, question, meta);
      // Log only the business id, outcome, model and timing (never the question or the document).
      console.log(
        `ask-document business=${businessId} found=${result.found} verified=${result.verified !== false} model=${meta.model || "-"} ms=${Date.now() - startedAt}`
      );
      sendJson(res, 200, result, corsHeaders);
    } catch (err) {
      console.error(`ask-document business=${businessId} failed: ${err.message} ms=${Date.now() - startedAt}`);
      const contact = business.config.fallbackContact || "contact the business directly";
      sendJson(
        res,
        502,
        { error: `The assistant is busy right now. Please try again in a moment, or ${contact}.` },
        corsHeaders
      );
    }
  });
}

// --- POST /api/lead: the visitor confirmed a lead; validate it and hand it to delivery -------------
// Nothing is stored. Never log the lead or any message text: only the business id and the outcome.
function handleLead(req, res, corsHeaders) {
  let body = "";
  let tooLarge = false;
  req.on("data", (chunk) => {
    if (tooLarge) return;
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      tooLarge = true;
      body = "";
      res.on("finish", () => req.destroy());
      sendJson(res, 413, { error: "Request too large." }, { ...corsHeaders, Connection: "close" });
    }
  });

  req.on("end", async () => {
    if (tooLarge) return;

    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      parsed = null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) parsed = {};

    // Hidden spam-trap field: real visitors never fill it. Pretend it worked, do nothing, don't count it.
    if (parsed.website !== undefined && parsed.website !== null && parsed.website !== "") {
      console.log("lead honeypot_hit=1");
      return sendJson(res, 200, { ok: true }, corsHeaders);
    }

    const retryAfter = leadLimiter.check(clientIp(req));
    if (retryAfter) {
      return sendJson(
        res,
        429,
        { error: "Too many submissions. Please try again later." },
        { ...corsHeaders, "Retry-After": String(retryAfter) }
      );
    }

    if (typeof parsed.business !== "string" || !Object.prototype.hasOwnProperty.call(BUSINESSES, parsed.business)) {
      return sendJson(res, 400, { error: "Unknown business." }, corsHeaders);
    }
    const business = BUSINESSES[parsed.business];
    if (!business.lead) {
      return sendJson(res, 400, { error: "Lead capture is not enabled for this business." }, corsHeaders);
    }

    // No chat history is sent here, so the "visitor typed it" check is skipped.
    const result = validateLead(parsed.lead, business.lead.interests);
    if (!result.ok) {
      console.log(`lead business=${parsed.business} result=invalid field=${result.field}`);
      return sendJson(res, 400, { error: "invalid", field: result.field, reason: result.reason }, corsHeaders);
    }

    try {
      await hooks.deliverLead(result.lead, business);
      console.log(`lead business=${parsed.business} result=delivered`);
      sendJson(res, 200, { ok: true }, corsHeaders);
    } catch (err) {
      if (err && err.code === "NOT_CONFIGURED") {
        console.log(`lead business=${parsed.business} result=not_configured`);
        return sendJson(res, 501, { error: "delivery_not_configured" }, corsHeaders);
      }
      console.error(`lead business=${parsed.business} delivery_failed code=${(err && err.code) || "unknown"}`);
      sendJson(res, 502, { error: "delivery_failed" }, corsHeaders);
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
  const publicConfig = {
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
  if (config.mode === "document") {
    publicConfig.mode = "document";
    publicConfig.documentTitle = safeText(config.documentTitle, 80, "");
    publicConfig.exampleQuestions = (Array.isArray(config.exampleQuestions) ? config.exampleQuestions : [])
      .filter((q) => typeof q === "string" && q.trim())
      .slice(0, 5)
      .map((q) => q.slice(0, 120));
  }
  const lead = getLeadConfig(config);
  if (lead) {
    publicConfig.leadCapture = { enabled: true, interests: lead.interests };
    if (lead.successNote) publicConfig.leadCapture.successNote = lead.successNote;
  }
  return publicConfig;
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

// --- GET /api/document: the full text of a document business, for the page's handbook viewer ---
function handleDocument(req, res) {
  const corsHeaders = checkOrigin(req);
  if (!corsHeaders) return sendJson(res, 403, { error: "Origin not allowed." });

  const requestedId = new URL(req.url, "http://localhost").searchParams.get("business");
  const businessId = requestedId ? requestedId : DEFAULT_BUSINESS;
  // The id is only ever used as a key into the in-memory object, never to build a path.
  if (!Object.prototype.hasOwnProperty.call(BUSINESSES, businessId)) {
    return sendJson(res, 404, { error: "Unknown business." });
  }
  const business = BUSINESSES[businessId];
  if (business.config.mode !== "document" || !business.doc) {
    return sendJson(res, 404, { error: "No document for this business." });
  }

  const headers = { "Cache-Control": "public, max-age=300" };
  if (corsHeaders["Access-Control-Allow-Origin"]) {
    headers["Access-Control-Allow-Origin"] = corsHeaders["Access-Control-Allow-Origin"];
    headers.Vary = "Origin";
  }
  sendJson(res, 200, { title: safeText(business.config.documentTitle, 80, ""), text: business.doc.text }, headers);
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];
  const postRoutes = { "/api/chat": handleChat, "/api/ask-document": handleAskDocument, "/api/lead": handleLead };
  if (Object.prototype.hasOwnProperty.call(postRoutes, pathname) && (req.method === "POST" || req.method === "OPTIONS")) {
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
    postRoutes[pathname](req, res, corsHeaders);
    return;
  }
  if (req.method === "GET" && pathname === "/api/config") {
    handleConfig(req, res);
    return;
  }
  if (req.method === "GET" && pathname === "/api/document") {
    handleDocument(req, res);
    return;
  }
  if (req.method === "GET") {
    serveStaticFile(req, res);
    return;
  }
  res.writeHead(405);
  res.end("Method not allowed");
});

// Started normally with "node server.js"; test-document.js requires this file instead.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

module.exports = { server, normalise, normaliseWithMap, verifyQuote, hooks, BUSINESSES, buildPublicConfig };