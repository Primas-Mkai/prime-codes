// Dev-only tests for lead capture. Not needed at runtime.
//   node test-lead.js
// The model is faked (hooks.askGemini) and delivery is faked (hooks.deliverLead). The only server the
// tests talk to is this process on 127.0.0.1 plus one tiny local stand-in for Gemini. Nothing leaves the machine.
const http = require("http");
const { spawnSync } = require("child_process");
const V = require("./lead-validation");

const CHILD = process.argv.includes("--child-global");
if (CHILD) {
  process.env.LEAD_RATE_LIMIT_MAX = "1";
  process.env.LEAD_GLOBAL_LIMIT_MAX = "2";
}

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
}

let port;
function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
          resolve({ status: res.statusCode, json, text: data, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
let ipCounter = 0;
const freshIp = () => ({ "X-Forwarded-For": `10.1.0.${++ipCounter}` });

const INTERESTS = ["Checkout", "Payouts", "Dashboard", "API", "Other"];
const GOOD = { name: "Amina Juma", email: "Amina@Example.com", interest: "API", message: "We want to test the API." };
const validate = (lead, visitor) => V.validateLead(lead, INTERESTS, visitor ? { visitorMessages: visitor } : {});

// A 15-digit number that passes the Luhn check (built here so the test does not rely on a magic value).
function luhn15() {
  for (let n = 100000000000000; n < 100000000001000; n++) if (V.luhnValid(String(n))) return String(n);
}

async function startFakeGemini() {
  const seen = []; // every request body the stand-in received
  const responses = []; // messages to answer with, in order; when empty, a default tool call is returned
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.push(JSON.parse(b));
      const message = responses.length
        ? responses.shift()
        : { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "propose_lead", arguments: "{}" } }] };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, seen, responses, url: `http://127.0.0.1:${server.address().port}/v1` };
}

async function childMain(app) {
  // Global-cap behaviour: a blocked visitor must not use up the global allowance.
  const post = (ip) => request("POST", "/api/lead", { business: "menospay", lead: GOOD }, { "X-Forwarded-For": ip });
  const out = [];
  for (const ip of ["1.1.1.1", "1.1.1.1", "1.1.1.1", "2.2.2.2", "3.3.3.3"]) out.push((await post(ip)).status);
  console.log("RESULT " + JSON.stringify(out));
  app.server.close();
  process.exitCode = 0;
}

async function main() {
  const fake = await startFakeGemini();
  process.env.GEMINI_URL = fake.url;
  process.env.GEMINI_API_KEY = "dummy";
  // Tests must never send a real email: empty values here win over anything in .env (the loader never overwrites).
  process.env.RESEND_API_KEY = "";
  process.env.LEAD_TO_EMAIL = "";
  const app = require("./server.js");
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  port = app.server.address().port;

  if (CHILD) {
    await childMain(app);
    fake.server.close();
    return;
  }

  // ------------------------------------------------------------------ validator
  console.log("--- validator");
  let r = validate(GOOD, ["Hi, I am Amina Juma, amina@example.com, I want the API"]);
  check("valid lead with email only (email lowercased, interest kept)", r.ok && r.lead.email === "amina@example.com" && r.lead.phone === "" && r.lead.interest === "API" && r.lead.name === "Amina Juma", r);
  r = validate({ name: "Juma Ali", phone: "+255 700-000.111", interest: "Payouts" });
  check("valid lead with phone only (stored as + and digits)", r.ok && r.lead.phone === "+255700000111" && r.lead.email === "", r);
  r = validate({ name: "Juma Ali", interest: "Payouts" });
  check("missing contact -> rejected", !r.ok && r.field === "email" && /contact/.test(r.reason), r);
  r = validate({ ...GOOD, name: "A" });
  check("name too short -> rejected", !r.ok && r.field === "name", r);
  r = validate({ ...GOOD, name: "x".repeat(81) });
  check("name too long -> rejected", !r.ok && r.field === "name", r);
  for (const [label, text] of [["https link", "see https://evil.example/x"], ["www link", "go to www.evil.example"], ["domain-like text", "visit evil.example now"]]) {
    r = validate({ ...GOOD, message: text });
    check(`${label} in message -> rejected`, !r.ok && r.field === "message", r);
  }
  r = validate({ ...GOOD, company: "Acme <b>Ltd</b>" });
  check("HTML characters -> rejected", !r.ok && r.field === "company" && /< or >/.test(r.reason), r);
  r = validate({ ...GOOD, email: "not-an-email" });
  check("invalid email -> rejected", !r.ok && r.field === "email", r);
  r = validate({ ...GOOD, email: undefined, phone: "07oo123456" });
  check("phone with letters -> rejected", !r.ok && r.field === "phone", r);
  r = validate({ ...GOOD, email: undefined, phone: "12345" });
  check("phone too short -> rejected", !r.ok && r.field === "phone", r);
  r = validate({ ...GOOD, interest: "Loans" });
  check("unknown interest -> rejected", !r.ok && r.field === "interest", r);
  r = validate({ ...GOOD, interest: "api" });
  check("interest matched case-insensitively and normalised", r.ok && r.lead.interest === "API", r);
  r = validate({ ...GOOD, message: "my card is 4111 1111 1111 1111" });
  check("Luhn-valid card number in message -> rejected", !r.ok && r.field === "message" && /card number/.test(r.reason), r);
  r = validate({ ...GOOD, message: "pay with 4111-1111-1111-1111 please" });
  check("card number with dashes -> rejected", !r.ok && /card number/.test(r.reason), r);
  r = validate({ ...GOOD, name: "Amina 4111111111111111" });
  check("card number in the name field -> rejected", !r.ok && r.field === "name", r);
  r = validate({ ...GOOD, message: "reference 1234 5678 9012 3456" });
  check("16 digits that fail Luhn are not treated as a card", r.ok, r);
  r = validate({ name: "Juma Ali", phone: "255700000111", interest: "Other" });
  check("normal 12-digit phone number is not rejected", r.ok && r.lead.phone === "255700000111", r);
  const p15 = luhn15();
  r = validate({ name: "Juma Ali", phone: p15, interest: "Other" });
  check("a 15-digit Luhn-valid phone is exempt in the phone field", r.ok, r);
  r = validate({ ...GOOD, message: p15 });
  check("the same digits in the message are rejected as a card number", !r.ok && /card number/.test(r.reason), r);
  r = validate({ name: "Juma Ali", phone: "4111 1111 1111 1111", interest: "Other" });
  check("a 16-digit Luhn-valid 'phone' -> rejected as a card number", !r.ok && /card number/.test(r.reason), r);
  r = validate({ name: "Juma\u0007 Ali\n", email: " a@b.co ", interest: "Other" });
  check("control characters removed, spaces trimmed", r.ok && r.lead.name === "Juma Ali" && r.lead.email === "a@b.co", r);
  r = validate({ ...GOOD, email: "amina@example.com", message: "write to amina@example.com" });
  check("an email address inside the message field is rejected (domain-like)", !r.ok && r.field === "message", r);
  r = validate({ ...GOOD, name: 42 });
  check("non-text field -> rejected", !r.ok && r.field === "name", r);
  r = validate("nope");
  check("non-object lead -> rejected", !r.ok, r);

  console.log("--- validator: the visitor must have typed the contact");
  r = validate(GOOD, ["Hello", "My name is Amina and I like the API"]);
  check("email the visitor never typed -> rejected", !r.ok && r.field === "email" && /not provided by the visitor/.test(r.reason), r);
  r = validate(GOOD, ["my email is AMINA@EXAMPLE.COM"]);
  check("email typed in a different case -> accepted", r.ok, r);
  r = validate({ name: "Juma Ali", phone: "+255700000111", interest: "Other" }, ["call me on +255 700 000 111"]);
  check("phone typed with spaces matches by digits -> accepted", r.ok, r);
  r = validate({ name: "Juma Ali", phone: "+255700000111", interest: "Other" }, ["call me on +255 700 000 999"]);
  check("phone the visitor never typed -> rejected", !r.ok && r.field === "phone", r);
  r = validate(GOOD);
  check("without visitor messages the check is skipped (used by /api/lead)", r.ok, r);

  // ------------------------------------------------------------------ real askGemini with tools (local stand-in)
  console.log("--- askGemini sends tools (against a local stand-in, not Gemini)");
  const realAsk = app.hooks.askGemini;
  const msg = await realAsk([{ role: "user", content: "hi" }], { tools: [{ type: "function", function: { name: "propose_lead" } }], toolChoice: "auto", returnMessage: true });
  const sent = fake.seen[fake.seen.length - 1];
  check("request carries tools and tool_choice 'auto'", Array.isArray(sent.tools) && sent.tools[0].function.name === "propose_lead" && sent.tool_choice === "auto", sent);
  check("returnMessage gives the whole message with tool_calls", msg.tool_calls && msg.tool_calls[0].function.name === "propose_lead", msg);
  let threw = false;
  try { await realAsk([{ role: "user", content: "hi" }], { deadline: Date.now() - 1 }); } catch (e) { threw = true; }
  check("a deadline already in the past stops the call before any request", threw && fake.seen.length === 1, fake.seen.length);

  // ------------------------------------------------------------------ fake model for the routes
  let queue = [];
  let calls = [];
  const useFake = (...replies) => {
    queue = replies;
    calls = [];
    app.hooks.askGemini = async (messages, options) => {
      calls.push({ messages, options });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    };
  };
  const text = (content) => ({ role: "assistant", content });
  const tool = (args, content = null, id = "call_a") => ({
    role: "assistant",
    content,
    tool_calls: [{ id, type: "function", function: { name: "propose_lead", arguments: typeof args === "string" ? args : JSON.stringify(args) } }],
  });
  const chat = (business, message, history = []) => request("POST", "/api/chat", { business, message, history }, freshIp());
  const goodArgs = { name: "Amina Juma", email: "amina@example.com", interest: "API", message: "Need sandbox access" };

  console.log("--- /api/config");
  r = await request("GET", "/api/config?business=menospay");
  check("menospay config has leadCapture with its interests", r.json.leadCapture && r.json.leadCapture.enabled === true && JSON.stringify(r.json.leadCapture.interests) === JSON.stringify(INTERESTS), r.json);
  check("menospay config: whitelisted keys only, no contact email/keys/fallbackContact",
    Object.keys(r.json).sort().join() === "assistantName,buttonLabel,greeting,leadCapture,name,theme" && !/hello@menospay|fallback|KEY|RESEND/i.test(r.text), Object.keys(r.json));
  check("menospay leadCapture has exactly enabled, interests and the successNote text",
    Object.keys(r.json.leadCapture).sort().join() === "enabled,interests,successNote" && r.json.leadCapture.successNote === "This is a demo, so no reply will come.", r.json.leadCapture);
  const note = (successNote) => app.buildPublicConfig({ name: "X", leadCapture: { enabled: true, interests: ["A"], successNote } }).leadCapture;
  check("successNote is exposed only when it is 1 to 120 characters once cleaned",
    note("  a\u0007b \n c  ").successNote === "a b c" && note("x".repeat(120)).successNote.length === 120 &&
    !("successNote" in note("x".repeat(121))) && !("successNote" in note("")) && !("successNote" in note("   ")) && !("successNote" in note(42)) && !("successNote" in note(undefined)), null);
  check("menospay theme and labels", r.json.name === "Menos Pay" && r.json.buttonLabel === "Ask Menos Pay" && r.json.theme.primary === "#0F2A43" && r.json.theme.accent === "#1FB5A0", r.json);
  for (const id of ["daily-grind", "menos-trails", "menos-academy"]) {
    r = await request("GET", "/api/config?business=" + id);
    check(`${id} config has no leadCapture (and so no successNote)`, r.status === 200 && !("leadCapture" in r.json) && !/successNote/.test(r.text), r.json);
  }

  console.log("--- /api/chat with the propose_lead tool");
  useFake(text("Hello! How can I help?"));
  r = await chat("menospay", "hi");
  const opt = calls[0].options;
  check("lead business: tool + tool_choice 'auto' are sent", opt.tools && opt.toolChoice === "auto" && opt.returnMessage === true, opt);
  const fn = opt.tools[0].function;
  check("tool has the right name, parameters and enum", fn.name === "propose_lead" && Object.keys(fn.parameters.properties).join() === "name,email,phone,company,interest,message" &&
    JSON.stringify(fn.parameters.properties.interest.enum) === JSON.stringify(INTERESTS) && fn.parameters.required.join() === "name,interest", fn);
  check("tool description says it only shows a summary and sends nothing", /never invent/i.test(fn.description) && /sends nothing/i.test(fn.description) && /name, at least one contact/.test(fn.description), fn.description);
  check("system prompt carries the 'do not imply it was sent' rule", /do not say or imply that the details have been sent/i.test(calls[0].messages[0].content) && calls[0].messages[0].content.includes("MENOS PAY"), null);
  check("plain text reply keeps the existing shape (no lead)", r.status === 200 && r.json.reply === "Hello! How can I help?" && !("lead" in r.json), r.json);

  useFake(tool(goodArgs, "Here is what I have:"));
  r = await chat("menospay", "my name is Amina Juma, amina@example.com, I want API access");
  check("valid proposal -> reply plus normalised lead", r.status === 200 && r.json.reply === "Here is what I have:" && r.json.lead && r.json.lead.email === "amina@example.com" && r.json.lead.interest === "API" && calls.length === 1, r.json);
  useFake(tool(goodArgs, null));
  r = await chat("menospay", "amina@example.com", [{ role: "user", content: "I am Amina Juma and I want the API" }, { role: "assistant", content: "Your email?" }]);
  check("no model text -> the fixed bilingual confirm reply", r.json.reply === "Please check the details below and press Send. / Tafadhali hakiki taarifa hapa chini kisha bonyeza Tuma." && r.json.lead, r.json);

  useFake(tool({ ...goodArgs, email: "invented@nowhere.co" }), text("Sorry, which email should I use?"));
  r = await chat("menospay", "I am Amina Juma and want the API, my email is amina@example.com");
  check("invented email -> not shown; one extra call with the tool result; model's question returned",
    r.status === 200 && !("lead" in r.json) && r.json.reply === "Sorry, which email should I use?" && calls.length === 2, { json: r.json, calls: calls.length });
  const toolMsg = calls[1] && calls[1].messages.find((m) => m.role === "tool");
  check("the extra call carries a tool result naming the field and reason",
    toolMsg && toolMsg.tool_call_id === "call_a" && JSON.parse(toolMsg.content).error.startsWith("email was not provided by the visitor") && calls[1].messages.some((m) => m.tool_calls), toolMsg);
  check("both calls share one time budget (same deadline)", calls[0].options.deadline && calls[0].options.deadline === calls[1].options.deadline && calls[0].options.deadline <= Date.now() + 25000, calls.map((c) => c.options.deadline));

  useFake(tool("{not json"), text("Could you repeat your details?"));
  r = await chat("menospay", "hi, I am Amina");
  check("invalid JSON arguments -> failed proposal, one correction round", !("lead" in r.json) && r.json.reply === "Could you repeat your details?" && calls.length === 2, r.json);

  useFake(tool({ ...goodArgs, email: "invented@nowhere.co" }), tool({ ...goodArgs, email: "still-invented@nowhere.co" }));
  r = await chat("menospay", "I am Amina and want the API");
  check("invalid twice -> normal friendly fallback with the business contact (502), no lead",
    r.status === 502 && /busy right now/.test(r.json.error) && r.json.error.includes("hello@menospay.example") && !("lead" in r.json) && calls.length === 2, { status: r.status, json: r.json, calls: calls.length });

  useFake(tool({ ...goodArgs, email: "invented@nowhere.co" }), tool(goodArgs, "Fixed:"));
  r = await chat("menospay", "I am Amina, amina@example.com, API please");
  check("a corrected proposal in the extra round is accepted", r.status === 200 && r.json.lead && r.json.reply === "Fixed:" && calls.length === 2, r.json);

  useFake(tool(goodArgs), tool(goodArgs));
  r = await chat("menospay", "I want the API, I am Amina Juma", [{ role: "user", content: "hi" }, { role: "assistant", content: "Tell me your email, for example amina@example.com" }]);
  check("an email that only the ASSISTANT wrote does not count as visitor-provided (rejected twice -> 502, no lead)", r.status === 502 && !("lead" in r.json) && calls.length === 2, { status: r.status, calls: calls.length });

  useFake(tool(goodArgs), tool(goodArgs));
  r = await chat("menospay", "x");
  check("no text and no valid proposal on both rounds -> 502", r.status === 502, r.status);

  useFake(new Error("AI provider failed (last status 503)"));
  r = await chat("menospay", "hello");
  check("model failure -> 502 with the Menos Pay contact", r.status === 502 && r.json.error.includes("hello@menospay.example"), r.json);

  console.log("--- tool call without a usable id (real askGemini against the local stand-in)");
  app.hooks.askGemini = realAsk;
  const badArgs = JSON.stringify({ ...goodArgs, email: "invented@nowhere.co" });
  const badArgsObject = { ...goodArgs, email: "invented@nowhere.co" };
  for (const [label, id, args] of [
    ["no id", undefined, badArgs],
    ["an empty id", "", badArgs],
    ["a numeric id", 123, badArgs],
    ["an id that is only spaces", "   ", badArgs],
    ["arguments that are an object instead of a string (no id)", undefined, badArgsObject],
    ["a normal id (kept as it is)", "call_xyz", badArgs],
  ]) {
    const call = { type: "function", function: { name: "propose_lead", arguments: args } };
    if (id !== undefined) call.id = id;
    const before = fake.seen.length;
    fake.responses.push({ role: "assistant", content: null, tool_calls: [call] }, { role: "assistant", content: "Which email should I use?" });
    r = await chat("menospay", "I am Amina Juma and I want the API, my email is amina@example.com");
    const reqs = fake.seen.slice(before);
    const follow = reqs[1];
    const assistantMsg = follow && follow.messages.find((m) => m.tool_calls);
    const toolResult = follow && follow.messages.find((m) => m.role === "tool");
    const entry = assistantMsg && assistantMsg.tool_calls[0];
    check(`${label}: two model requests and a normal result (the model's question, no lead)`,
      reqs.length === 2 && r.status === 200 && r.json.reply === "Which email should I use?" && !("lead" in r.json), { reqs: reqs.length, status: r.status, json: r.json });
    check(`${label}: the follow-up entry has type function, a string id, and string name and arguments`,
      entry && entry.type === "function" && typeof entry.id === "string" && entry.id.trim() !== "" &&
      typeof entry.function.name === "string" && entry.function.name === "propose_lead" && typeof entry.function.arguments === "string" &&
      entry.function.arguments === (typeof args === "string" ? args : JSON.stringify(args)), entry);
    check(`${label}: the tool result tells the model what was wrong (the email was never typed by the visitor)`,
      toolResult && JSON.parse(toolResult.content).error.startsWith("email was not provided by the visitor"), toolResult && toolResult.content);
    check(`${label}: the tool result uses the same id as the assistant's tool call`,
      toolResult && toolResult.tool_call_id === entry.id && (id === "call_xyz" ? entry.id === "call_xyz" : entry.id.startsWith("call_") && entry.id.length > 8), { tool: toolResult && toolResult.tool_call_id, entry: entry && entry.id });
  }
  // The model's own message object must not be changed, and the visitor's text is passed on untouched.
  const original = { role: "assistant", content: null, tool_calls: [{ type: "function", function: { name: "propose_lead", arguments: badArgs } }] };
  const snapshot = JSON.stringify(original);
  useFake(original, text("Which email should I use?"));
  const typed = "I am Amina Juma and I want the API, my email is amina@example.com";
  const sentHistory = [{ role: "user", content: "hello there" }];
  const historySnapshot = JSON.stringify(sentHistory);
  r = await chat("menospay", typed, sentHistory);
  check("the model's tool call object is not mutated", JSON.stringify(original) === snapshot && calls.length === 2, calls.length);
  check("the follow-up gets a generated id while the original has none", calls[1].messages.find((m) => m.tool_calls).tool_calls[0].id.startsWith("call_") && original.tool_calls[0].id === undefined, null);
  check("the visitor's messages are passed on unchanged", calls[1].messages.filter((m) => m.role === "user").map((m) => m.content).join("|") === "hello there|" + typed && JSON.stringify(sentHistory) === historySnapshot, null);

  console.log("--- a business without leadCapture ignores the tool");
  useFake("Fake plain reply");
  r = await chat("daily-grind", "hello");
  check("daily-grind: no tools, no returnMessage, plain string reply", calls.length === 1 && calls[0].options === undefined && r.status === 200 && r.json.reply === "Fake plain reply" && !("lead" in r.json), { options: calls[0] && calls[0].options, json: r.json });
  check("daily-grind: system prompt has no lead-capture instruction", !/propose_lead|Lead capture rule/.test(calls[0].messages[0].content), null);
  useFake("Fake trails reply");
  r = await chat("menos-trails", "hello");
  check("menos-trails: plain string reply, no tools", calls.length === 1 && calls[0].options === undefined && r.json.reply === "Fake trails reply", r.json);
  r = await request("POST", "/api/lead", { business: "daily-grind", lead: GOOD }, freshIp());
  check("/api/lead for a business without leadCapture -> 400", r.status === 400 && /not enabled/.test(r.json.error), r.json);

  // ------------------------------------------------------------------ /api/lead
  console.log("--- POST /api/lead");
  const lead = (body, headers) => request("POST", "/api/lead", { business: "menospay", ...body }, headers || freshIp());
  r = await lead({ lead: GOOD });
  check("valid lead, delivery not configured -> 501 delivery_not_configured", r.status === 501 && r.json.error === "delivery_not_configured", r.json);
  let delivered = [];
  app.hooks.deliverLead = async (l, b) => { delivered.push({ l, b }); };
  r = await lead({ lead: GOOD, website: "" });
  check("delivery succeeds -> 200 { ok: true }, with the normalised lead", r.status === 200 && r.json.ok === true && delivered.length === 1 && delivered[0].l.email === "amina@example.com" && delivered[0].l.interest === "API", { r: r.json, delivered: delivered.length });
  delivered = [];
  r = await lead({ lead: GOOD, website: "http://spam.example" });
  check("honeypot filled -> 200 { ok: true } and nothing delivered", r.status === 200 && r.json.ok === true && delivered.length === 0, { r: r.json, delivered: delivered.length });
  r = await lead({ lead: { ...GOOD, email: "bad" } });
  check("invalid lead -> 400 { error: 'invalid', field, reason }", r.status === 400 && r.json.error === "invalid" && r.json.field === "email" && typeof r.json.reason === "string", r.json);
  check("nothing delivered for an invalid lead", delivered.length === 0, delivered.length);
  r = await lead({ lead: { ...GOOD, message: "pay 4111 1111 1111 1111" } });
  check("card number in /api/lead -> 400", r.status === 400 && /card number/.test(r.json.reason), r.json);
  r = await request("POST", "/api/lead", { business: "nope", lead: GOOD }, freshIp());
  check("unknown business -> 400", r.status === 400 && r.json.error === "Unknown business.", r.json);
  r = await request("POST", "/api/lead", { business: "../../.env", lead: GOOD }, freshIp());
  check("path-like business -> 400, never used as a path", r.status === 400 && r.json.error === "Unknown business.", r.json);
  r = await request("POST", "/api/lead", "{bad json", freshIp());
  check("invalid JSON -> 400", r.status === 400, r.status);
  r = await request("POST", "/api/lead", JSON.stringify({ business: "menospay", lead: { ...GOOD, message: "x".repeat(25000) } }), freshIp());
  check("body over 20 KB -> 413", r.status === 413, r.status);
  app.hooks.deliverLead = async () => { const e = new Error("boom"); e.code = "SMTP_DOWN"; throw e; };
  r = await lead({ lead: GOOD });
  check("delivery fails for another reason -> 502 delivery_failed", r.status === 502 && r.json.error === "delivery_failed", r.json);
  app.hooks.deliverLead = require("./lead-delivery").deliverLead;

  console.log("--- /api/lead CORS");
  r = await request("POST", "/api/lead", { business: "menospay", lead: GOOD }, { ...freshIp(), Origin: "https://evil.example" });
  check("evil origin -> 403, no CORS headers", r.status === 403 && !r.headers["access-control-allow-origin"], r.status);
  r = await request("POST", "/api/lead", { business: "menospay", lead: GOOD }, { ...freshIp(), Origin: "http://localhost:5500" });
  check("allowed origin -> CORS headers", r.headers["access-control-allow-origin"] === "http://localhost:5500" && r.headers.vary === "Origin", r.headers);
  r = await request("OPTIONS", "/api/lead", undefined, { Origin: "http://localhost:5500", "Access-Control-Request-Method": "POST" });
  check("preflight -> 204", r.status === 204, r.status);

  console.log("--- /api/lead rate limits");
  const ip = { "X-Forwarded-For": "7.7.7.7" };
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await lead({ lead: GOOD }, ip)).status);
  check("per visitor: default 3 per hour, the 4th -> 429", statuses.join() === "501,501,501,429", statuses);
  r = await lead({ lead: GOOD }, ip);
  check("429 carries Retry-After and a friendly message", r.status === 429 && Number(r.headers["retry-after"]) > 0 && /Too many/.test(r.json.error), { h: r.headers["retry-after"], j: r.json });
  const ip2 = { "X-Forwarded-For": "8.8.8.8" };
  for (let i = 0; i < 10; i++) await lead({ lead: GOOD, website: "x" }, ip2);
  const after = [];
  for (let i = 0; i < 3; i++) after.push((await lead({ lead: GOOD }, ip2)).status);
  check("honeypot hits do not count toward the limit", after.join() === "501,501,501", after);

  const child = spawnSync(process.execPath, [__filename, "--child-global"], { encoding: "utf8", env: process.env });
  const line = (child.stdout.match(/RESULT (.*)/) || [])[1];
  check("global cap: a blocked visitor does not use up the global allowance (501,429,429,501,429)", line === "[501,429,429,501,429]", { line, err: child.stderr && child.stderr.slice(0, 200) });

  console.log("--- other routes are unaffected");
  r = await request("GET", "/api/config?business=daily-grind");
  check("GET /api/config daily-grind still works", r.status === 200 && r.json.name === "The Daily Grind", r.json);
  r = await request("POST", "/api/ask-document", { business: "menospay", question: "hi" }, freshIp());
  check("/api/ask-document for a non-document business still -> 400", r.status === 400, r.json);

  console.log(`\n${passed} passed, ${failed} failed`);
  app.server.close();
  fake.server.close();
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
