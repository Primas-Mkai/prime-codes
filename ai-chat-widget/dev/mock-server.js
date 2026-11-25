// Dev-only mock of the chat server, for trying the lead confirm card without Gemini, Render or a network.
// Not part of the real server and never served by it (this folder is outside public/).
//   node dev/mock-server.js                       -> http://localhost:4100
//   $env:MOCK_LEAD_RESULT="notconfigured"; node dev/mock-server.js     (PowerShell)
// MOCK_LEAD_RESULT: ok (default), invalid, rate, notconfigured, fail, slow
// Lead contents are never logged.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 4100;
const RESULTS = ["ok", "invalid", "rate", "notconfigured", "fail", "slow"];

const CONFIG = {
  name: "Menos Pay",
  assistantName: "Menos Pay assistant",
  greeting: "Hi! I'm the Menos Pay demo assistant. Ask me about payments, fees, or any fintech word you find confusing. (Menos Pay is a fictional demo company.)",
  buttonLabel: "Ask Menos Pay",
  theme: { primary: "#0F2A43", accent: "#1FB5A0", primaryText: "#FFFFFF", accentText: "#0F2A43" },
  leadCapture: { enabled: true, interests: ["Checkout", "Payouts", "Dashboard", "API", "Other"], successNote: "This is a demo, so no reply will come." },
};
// A second business WITHOUT lead capture, to check the widget behaves exactly as before for it.
const PLAIN_CONFIG = { name: "Plain Shop", assistantName: "Plain Shop assistant", greeting: "Hello!", buttonLabel: "Ask us anything", theme: CONFIG.theme };

const LEAD = { name: "Amina Juma", email: "amina@example.com", phone: "", company: "Juma Shop", interest: "API", message: "Demo please." };

function createMockServer(options = {}) {
  const leadResult = options.leadResult || process.env.MOCK_LEAD_RESULT || "ok";
  // stats exist for the tests only; the contents of a lead are never printed.
  const stats = { leadRequests: 0, chatRequests: 0, lastLeadBody: null, lastChatBody: null };
  const page = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  // options.successNote === false leaves the optional note out of the mocked config (for tests).
  const config = { ...CONFIG, leadCapture: { ...CONFIG.leadCapture } };
  if (options.successNote === false) delete config.leadCapture.successNote;

  function json(res, status, obj, headers = {}) {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(obj));
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = url.pathname;

    if (req.method === "GET" && (route === "/" || route === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(page);
    }
    if (req.method === "GET" && route === "/plain.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(page.replace('data-business="menospay"', 'data-business="plainshop"'));
    }
    if (req.method === "GET" && route === "/widget.js") {
      res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-cache" });
      return res.end(fs.readFileSync(path.join(__dirname, "..", "public", "widget.js")));
    }
    if (req.method === "GET" && route === "/api/config") {
      const id = url.searchParams.get("business");
      if (id === "menospay") return json(res, 200, config);
      if (id === "plainshop") return json(res, 200, PLAIN_CONFIG);
      return json(res, 404, { error: "Unknown business." });
    }

    if (req.method === "POST" && (route === "/api/chat" || route === "/api/lead")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch (e) { /* ignore */ }

        if (route === "/api/chat") {
          stats.chatRequests++;
          stats.lastChatBody = parsed;
          const message = String(parsed.message || "").toLowerCase();
          if (/\bxss\b/.test(message)) {
            return json(res, 200, { reply: "Check this.", lead: { ...LEAD, name: "<img src=x onerror=alert(1)>", message: "<b>bold</b>" } });
          }
          if (/\blead\b/.test(message)) {
            return json(res, 200, { reply: "Please check the details below and press Send.", lead: LEAD });
          }
          return json(res, 200, { reply: "This is a mock reply." });
        }

        // POST /api/lead
        if (typeof parsed.website === "string" && parsed.website !== "") return json(res, 200, { ok: true }); // spam trap
        stats.leadRequests++;
        stats.lastLeadBody = parsed;
        console.log(`mock lead result=${leadResult}`);
        switch (leadResult) {
          case "invalid": return json(res, 400, { error: "invalid", field: "email", reason: "is not a valid email address." });
          case "rate": return json(res, 429, { error: "Too many submissions. Please try again later." }, { "Retry-After": "60" });
          case "notconfigured": return json(res, 501, { error: "delivery_not_configured" });
          case "fail": return json(res, 502, { error: "delivery_failed" });
          case "slow": return setTimeout(() => json(res, 200, { ok: true }), 3000);
          default: return json(res, 200, { ok: true });
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  return { server, stats, leadResult };
}

module.exports = { createMockServer, RESULTS, LEAD, CONFIG };

if (require.main === module) {
  const mode = process.env.MOCK_LEAD_RESULT || "ok";
  if (!RESULTS.includes(mode)) {
    console.error(`MOCK_LEAD_RESULT must be one of: ${RESULTS.join(", ")} (got "${mode}")`);
    process.exit(1);
  }
  const { server } = createMockServer({ leadResult: mode });
  server.listen(PORT, () => console.log(`Mock chat server on http://localhost:${PORT}  (POST /api/lead answers: ${mode})`));
}
