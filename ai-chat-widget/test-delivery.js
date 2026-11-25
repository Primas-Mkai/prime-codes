// Dev-only tests for lead-delivery.js (emailing a lead through Resend). Not needed at runtime.
//   node test-delivery.js
// fetch is replaced by a stand-in for each test and restored afterwards: no network, no real email, no real key.
const http = require("http");
const { deliverLead } = require("./lead-delivery");

const KEY = "re_test_key_123";
const TO = "inbox@example.com";
const BUSINESS = { config: { name: "Menos Pay" } };
const LEAD = { name: "Amina Juma", email: "amina@example.com", phone: "", company: "Juma Shop", interest: "API", message: "Demo please." };

const printLine = console.log.bind(console); // scenario() captures console.log, so results are printed through this
let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else failed++;
  printLine(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
}

const realFetch = globalThis.fetch;
const ENV_NAMES = ["RESEND_API_KEY", "LEAD_TO_EMAIL", "LEAD_FROM_EMAIL"];

// Runs fn with the given settings and a stand-in fetch; restores both afterwards. Console output is captured.
async function scenario(env, standIn, fn) {
  const saved = {};
  for (const name of ENV_NAMES) saved[name] = process.env[name];
  for (const name of ENV_NAMES) {
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  }
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return standIn(url, options);
  };
  const output = [];
  const originals = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(originals)) console[k] = (...args) => output.push(args.map(String).join(" "));
  try {
    return await fn({ calls, output });
  } finally {
    Object.assign(console, originals);
    globalThis.fetch = realFetch;
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

const GOOD_ENV = { RESEND_API_KEY: KEY, LEAD_TO_EMAIL: TO };
const okAnswer = () => new Response(JSON.stringify({ id: "email_123" }), { status: 200 });

async function outcome(promise) {
  try {
    await promise;
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err.code, message: String(err.message) };
  }
}

function sentBody(call) {
  return JSON.parse(call.options.body);
}

async function main() {
  console.log("--- settings missing or wrong -> NOT_CONFIGURED (and nothing is sent)");
  const configs = [
    ["no RESEND_API_KEY", { LEAD_TO_EMAIL: TO }],
    ["empty RESEND_API_KEY", { RESEND_API_KEY: "  ", LEAD_TO_EMAIL: TO }],
    ["no LEAD_TO_EMAIL", { RESEND_API_KEY: KEY }],
    ["empty LEAD_TO_EMAIL", { RESEND_API_KEY: KEY, LEAD_TO_EMAIL: "" }],
    ["invalid LEAD_TO_EMAIL (no @)", { RESEND_API_KEY: KEY, LEAD_TO_EMAIL: "not-an-email" }],
    ["invalid LEAD_TO_EMAIL (no dot in the domain)", { RESEND_API_KEY: KEY, LEAD_TO_EMAIL: "a@b" }],
    ["LEAD_TO_EMAIL with two addresses", { RESEND_API_KEY: KEY, LEAD_TO_EMAIL: "a@example.com, b@example.com" }],
  ];
  for (const [label, env] of configs) {
    await scenario(env, okAnswer, async ({ calls }) => {
      const r = await outcome(deliverLead(LEAD, BUSINESS));
      check(`${label} -> NOT_CONFIGURED, fetch never called`, !r.ok && r.code === "NOT_CONFIGURED" && calls.length === 0, { r, calls: calls.length });
    });
  }

  console.log("--- the request to Resend");
  await scenario(GOOD_ENV, okAnswer, async ({ calls }) => {
    const r = await outcome(deliverLead(LEAD, BUSINESS));
    const call = calls[0];
    const body = call && sentBody(call);
    check("a 200 answer resolves", r.ok && calls.length === 1, r);
    check("POST to https://api.resend.com/emails", call.url === "https://api.resend.com/emails" && call.options.method === "POST", call.url);
    check('Authorization is "Bearer <key>" and the body is JSON',
      call.options.headers.Authorization === `Bearer ${KEY}` && call.options.headers["Content-Type"] === "application/json", Object.keys(call.options.headers));
    check("the request has a timeout signal", call.options.signal instanceof AbortSignal, null);
    check('"from" is built from the business name, not hard-coded', body.from === "Menos Pay <onboarding@resend.dev>", body.from);
    check('"to" is an array with the configured address', Array.isArray(body.to) && body.to.length === 1 && body.to[0] === TO, body.to);
    check('the subject starts "New Menos Pay lead: "', body.subject === "New Menos Pay lead: Amina Juma", body.subject);
    check("the text body has the agreed layout with the filled fields only",
      body.text === "New lead from the Menos Pay website chat.\n\nName: Amina Juma\nEmail: amina@example.com\nCompany: Juma Shop\nInterest: API\nMessage: Demo please.\n\nSent by the AI chat widget. The visitor pressed Send on the confirm card.", body.text);
    check("plain text only: there is no html property", !("html" in body) && Object.keys(body).sort().join() === "from,reply_to,subject,text,to", Object.keys(body));
    check("reply_to is the lead's email", body.reply_to === "amina@example.com", body.reply_to);
  });

  await scenario(GOOD_ENV, okAnswer, async ({ calls }) => {
    await deliverLead({ ...LEAD, email: "", phone: "+255700000111", company: "", message: "" }, BUSINESS);
    const body = sentBody(calls[0]);
    check("a lead without an email has no reply_to", !("reply_to" in body), Object.keys(body));
    check("phone-only lead: Phone line shown, no Email line, empty fields left out",
      body.text.includes("Phone: +255700000111") && !body.text.includes("Email:") && !body.text.includes("Company:") && !body.text.includes("Message:"), body.text);
  });

  await scenario({ ...GOOD_ENV, LEAD_FROM_EMAIL: "Leads <leads@example.com>" }, okAnswer, async ({ calls }) => {
    await deliverLead(LEAD, BUSINESS);
    check("LEAD_FROM_EMAIL is used when set", sentBody(calls[0]).from === "Leads <leads@example.com>", sentBody(calls[0]).from);
  });
  await scenario(GOOD_ENV, okAnswer, async ({ calls }) => {
    await deliverLead(LEAD, { config: { name: "Acme Co" } });
    const body = sentBody(calls[0]);
    check("another business: the default sender, subject and text use ITS name", body.from === "Acme Co <onboarding@resend.dev>" && body.subject === "New Acme Co lead: Amina Juma" && body.text.startsWith("New lead from the Acme Co website chat."), body);
  });

  console.log("--- header and line injection");
  await scenario(GOOD_ENV, okAnswer, async ({ calls }) => {
    await deliverLead({ ...LEAD, name: "Eve\r\nBcc: attacker@example.com\nInterest: Fake", message: "hi\r\nName: Fake" }, BUSINESS);
    const body = sentBody(calls[0]);
    const lines = body.text.split("\n");
    check("a CR/LF attack in the name cannot add a line to the subject", !/[\r\n]/.test(body.subject) && body.subject.startsWith("New Menos Pay lead: Eve"), body.subject);
    check("and cannot add lines to the text body",
      lines.filter((l) => l.startsWith("Interest:")).length === 1 && lines.filter((l) => l.startsWith("Name:")).length === 1 && !lines.some((l) => l.startsWith("Bcc:")) && lines.length === 9, lines);
    check("no extra recipients appear", body.to.length === 1 && !("bcc" in body) && !("cc" in body), body.to);
  });
  await scenario(GOOD_ENV, okAnswer, async ({ calls }) => {
    await deliverLead({ ...LEAD, name: "N".repeat(300) }, BUSINESS);
    check("the subject is cut to 120 characters", sentBody(calls[0]).subject.length === 120, sentBody(calls[0]).subject.length);
  });

  console.log("--- failures: codes only, and no secrets anywhere");
  const secrets = [KEY, LEAD.email, TO];
  const failures = [
    ["403", () => new Response(JSON.stringify({ message: `bad key ${KEY} for ${TO} and ${LEAD.email}` }), { status: 403 }), "RESEND_403"],
    ["422", () => new Response(JSON.stringify({ message: `invalid to ${TO}` }), { status: 422 }), "RESEND_422"],
    ["500", () => new Response("server error", { status: 500 }), "RESEND_500"],
    ["a fetch that rejects", () => { throw new TypeError(`fetch failed for ${TO} with ${KEY}`); }, "NETWORK"],
    ["a timeout (TimeoutError)", () => { throw new DOMException(`timed out ${KEY}`, "TimeoutError"); }, "TIMEOUT"],
    ["an abort (AbortError)", () => { throw new DOMException("aborted", "AbortError"); }, "TIMEOUT"],
  ];
  for (const [label, standIn, code] of failures) {
    await scenario(GOOD_ENV, standIn, async ({ output }) => {
      const r = await outcome(deliverLead(LEAD, BUSINESS));
      const text = JSON.stringify(r) + output.join("\n");
      check(`${label} -> ${code}`, !r.ok && r.code === code, r);
      check(`${label}: the error and the console output contain no key, lead email or recipient`, secrets.every((s) => !text.includes(s)), r.message);
    });
  }

  console.log("--- end to end through POST /api/lead (real deliverLead, stand-in fetch)");
  process.env.GEMINI_API_KEY = "dummy";
  process.env.RESEND_API_KEY = ""; // keep .env values out; each scenario sets its own fake settings
  process.env.LEAD_TO_EMAIL = "";
  const app = require("./server.js");
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const port = app.server.address().port;
  let ipCounter = 0;
  const post = (body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/lead", headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.9.0.${++ipCounter}` } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end(payload);
  });
  const lead = { name: "Amina Juma", email: "amina@example.com", interest: "API", message: "Demo please." };
  check("the server uses the real deliverLead by default", app.hooks.deliverLead === deliverLead, null);

  await scenario(GOOD_ENV, okAnswer, async ({ calls, output }) => {
    const r = await post({ business: "menospay", lead, website: "" });
    check("configured -> 200 { ok: true }", r.status === 200 && r.json.ok === true && calls.length === 1, r);
    const body = sentBody(calls[0]);
    check("the email carries the lead and the Menos Pay name", body.subject === "New Menos Pay lead: Amina Juma" && body.text.includes("Email: amina@example.com"), body.subject);
    check("the server's log lines contain no key, lead email or recipient", secrets.every((s) => !output.join("\n").includes(s)), output);
  });
  await scenario(GOOD_ENV, () => new Response("{}", { status: 500 }), async ({ output }) => {
    const r = await post({ business: "menospay", lead, website: "" });
    check("Resend failure -> 502 delivery_failed", r.status === 502 && r.json.error === "delivery_failed", r);
    check("and the log shows the code but no secrets", output.join("\n").includes("RESEND_500") && secrets.every((s) => !output.join("\n").includes(s)), output);
  });
  await scenario(GOOD_ENV, () => { throw new TypeError("offline"); }, async () => {
    const r = await post({ business: "menospay", lead, website: "" });
    check("network failure -> 502 delivery_failed", r.status === 502 && r.json.error === "delivery_failed", r);
  });
  await scenario({}, okAnswer, async ({ calls }) => {
    const r = await post({ business: "menospay", lead, website: "" });
    check("settings missing -> 501 delivery_not_configured, nothing sent", r.status === 501 && r.json.error === "delivery_not_configured" && calls.length === 0, r);
  });
  await scenario(GOOD_ENV, okAnswer, async ({ calls }) => {
    const r = await post({ business: "menospay", lead, website: "spam" });
    check("the spam trap sends no email", r.status === 200 && calls.length === 0, r);
    const bad = await post({ business: "menospay", lead: { ...lead, email: "nope" }, website: "" });
    check("an invalid lead sends no email", bad.status === 400 && calls.length === 0, bad);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  app.server.close();
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 300);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
