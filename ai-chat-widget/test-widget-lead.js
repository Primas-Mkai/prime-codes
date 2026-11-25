// Dev-only tests for the widget's lead confirm card. Not needed at runtime.
//   node test-widget-lead.js
// Uses dev/mock-server.js (in this process, on free ports). No Gemini, no network, no new dependencies.
// If Chrome or Edge is installed, it also drives the card in a headless browser through the DevTools protocol.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { createMockServer, RESULTS, LEAD } = require("./dev/mock-server.js");

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const widgetSource = fs.readFileSync(path.join(__dirname, "public", "widget.js"), "utf8");

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: { "Content-Type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, json, text: data, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function startMock(leadResult, options = {}) {
  const mock = createMockServer({ leadResult, ...options });
  await new Promise((r) => mock.server.listen(0, "127.0.0.1", r));
  mock.port = mock.server.address().port;
  return mock;
}

async function main() {
  // ------------------------------------------------------------------ widget.js, static checks
  console.log("--- widget.js (static)");
  for (const word of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "localStorage", "sessionStorage"]) {
    check(`widget.js does not contain ${word}`, !widgetSource.includes(word), word);
  }
  check('widget.js still reads data-business', widgetSource.includes("data-business"), null);
  check("widget.js has the card heading, the /api/lead call and the empty spam-trap field",
    widgetSource.includes("Check your details") && widgetSource.includes("/api/lead") && /website:\s*""/.test(widgetSource), null);
  check("the notice uses the name from the config, not a hard-coded one",
    widgetSource.includes('" team. Please do not share passwords or payment details."') && !/Menos Pay/.test(widgetSource), null);
  check("no globals are created (one wrapped function, no window.x = )", /^\s*\(function \(\) \{/m.test(widgetSource) && !/window\.\w+\s*=/.test(widgetSource), null);
  check("the only network targets are the server that served widget.js (no other http addresses except the SVG namespace)",
    (widgetSource.match(/https?:\/\/[^\s"')]+/g) || []).filter((u) => !u.includes("<server>")).every((u) => u === "http://www.w3.org/2000/svg"), widgetSource.match(/https?:\/\/[^\s"')]+/g));
  check("size reported", true, null);
  console.log(`      widget.js is ${Buffer.byteLength(widgetSource)} bytes`);

  // ------------------------------------------------------------------ mock server over HTTP
  console.log("--- mock server");
  const main = await startMock("ok");
  let r = await request(main.port, "POST", "/api/chat", { message: "I want a demo, lead please", history: [], business: "menospay" });
  check('chat with the word "lead" returns reply + lead', r.status === 200 && r.json.lead && r.json.lead.name === LEAD.name && typeof r.json.reply === "string", r.json);
  r = await request(main.port, "POST", "/api/chat", { message: "How much is the fee?", history: [], business: "menospay" });
  check("any other chat message returns no lead", r.status === 200 && r.json.reply === "This is a mock reply." && !("lead" in r.json), r.json);
  r = await request(main.port, "GET", "/api/config?business=menospay");
  check("config has the menospay shape with leadCapture", r.status === 200 && r.json.name === "Menos Pay" && r.json.leadCapture.enabled === true && r.json.leadCapture.interests.length === 5, r.json);
  r = await request(main.port, "GET", "/api/config?business=plainshop");
  check("the plain business has no leadCapture", r.status === 200 && !("leadCapture" in r.json), r.json);
  r = await request(main.port, "GET", "/widget.js");
  check("/widget.js is the real file", r.status === 200 && r.text === widgetSource, r.status);
  r = await request(main.port, "POST", "/api/lead", { business: "menospay", lead: LEAD, website: "spam" });
  check("a filled spam-trap field is answered 200 and not counted", r.status === 200 && main.stats.leadRequests === 0, main.stats.leadRequests);
  main.server.close();

  const expected = { ok: 200, invalid: 400, rate: 429, notconfigured: 501, fail: 502, slow: 200 };
  for (const mode of RESULTS) {
    const m = await startMock(mode);
    const started = Date.now();
    const res = await request(m.port, "POST", "/api/lead", { business: "menospay", lead: LEAD, website: "" });
    const took = Date.now() - started;
    let ok = res.status === expected[mode];
    if (mode === "invalid") ok = ok && res.json.error === "invalid" && res.json.field === "email" && typeof res.json.reason === "string";
    if (mode === "rate") ok = ok && Number(res.headers["retry-after"]) > 0;
    if (mode === "notconfigured") ok = ok && res.json.error === "delivery_not_configured";
    if (mode === "fail") ok = ok && res.json.error === "delivery_failed";
    if (mode === "slow") ok = ok && took >= 2900;
    if (mode === "ok") ok = ok && res.json.ok === true;
    check(`MOCK_LEAD_RESULT=${mode} -> ${expected[mode]}`, ok, { status: res.status, json: res.json, took });
    m.server.close();
  }

  // ------------------------------------------------------------------ the card in a real browser
  const CHROME = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ].find((p) => fs.existsSync(p));
  if (!CHROME) {
    console.log("\nNo Chrome/Edge found: the browser checks of the card were NOT run.");
    return finish();
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "widget-lead-"));
  const shots = fs.mkdtempSync(path.join(os.tmpdir(), "widget-lead-shots-"));
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" });
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    try { port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch (e) { /* not yet */ }
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((res) => (ws.onopen = res));
  let nextId = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === "Runtime.exceptionThrown") pageErrors.push(msg.params.exceptionDetails.text);
    if (msg.method === "Page.javascriptDialogOpening") pageErrors.push("a dialog opened: " + msg.params.message);
  };
  const send = (method, params = {}) => new Promise((res) => { const id = ++nextId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (expression) => {
    const out = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (out.result.exceptionDetails) throw new Error(JSON.stringify(out.result.exceptionDetails.exception || out.result.exceptionDetails));
    return out.result.result.value;
  };
  const waitFor = async (expression, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) { if (await evalJs(expression)) return true; await sleep(100); }
    return false;
  };
  await send("Page.enable");
  await send("Runtime.enable");

  const SR = `document.getElementById("ai-chat-widget-host").shadowRoot`;
  const q = (sel) => `${SR}.querySelector(${JSON.stringify(sel)})`;
  const qa = (sel) => `${SR}.querySelectorAll(${JSON.stringify(sel)})`;
  const ask = (text) => evalJs(`(() => { const i = ${q(".input")}; i.value = ${JSON.stringify(text)}; ${q(".form")}.requestSubmit(); return true; })()`);
  const cardCount = () => evalJs(`${qa(".card")}.length`);
  const lastCard = `[...${qa(".card")}].pop()`;
  const cardText = (sel) => evalJs(`(() => { const c = ${lastCard}; const e = c && c.querySelector(${JSON.stringify(sel)}); return e ? e.textContent : null; })()`);
  const btn = (name) => `${lastCard}.querySelector(".card-${name}")`;

  async function openPage(mock, pagePath = "/", width = 1280, height = 900) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    await send("Page.navigate", { url: `http://127.0.0.1:${mock.port}${pagePath}` });
    const ready = await waitFor(`!!document.getElementById("ai-chat-widget-host")`);
    if (!ready) throw new Error("the widget did not appear");
    await evalJs(`${q(".launcher")}.click(); true`);
    await waitFor(`!${q(".panel")}.hidden`);
  }
  async function getCard(mock, pagePath, width) {
    await openPage(mock, pagePath, width);
    await ask("I want a demo, lead please");
    return waitFor(`${qa(".card")}.length === 1`);
  }
  const shot = async (name) => send("Page.captureScreenshot", {}).then((x) => fs.writeFileSync(path.join(shots, name), Buffer.from(x.result.data, "base64")));

  console.log("\n--- the card in a headless browser (1280px)");
  {
    const mock = await startMock("ok");
    check("card appears under the reply", await getCard(mock, "/", 1280), null);
    check('card heading is "Check your details"', (await cardText(".card-title")) === "Check your details", await cardText(".card-title"));
    const rows = await evalJs(`[...${lastCard}.querySelectorAll(".card-row")].map(r => r.children[0].textContent + "=" + r.children[1].textContent)`);
    check("only the filled fields are shown, with labels", JSON.stringify(rows) === JSON.stringify(["Name=Amina Juma", "Email=amina@example.com", "Company=Juma Shop", "Interest=API", "Message=Demo please."]), rows);
    check('the notice names the business from the config ("the Menos Pay team")', (await cardText(".card-note")) === "Your details will be passed to the Menos Pay team. Please do not share passwords or payment details.", await cardText(".card-note"));
    check("Send and Edit are real buttons (type=button) in the page's tab order",
      await evalJs(`(() => { const s = ${btn("send")}, e = ${btn("edit")}; return s.tagName === "BUTTON" && s.type === "button" && e.tagName === "BUTTON" && e.type === "button" && s.tabIndex === 0 && e.tabIndex === 0 && s.textContent === "Send" && e.textContent === "Edit"; })()`), null);
    check("the status line is announced politely", await evalJs(`(() => { const s = ${lastCard}.querySelector(".card-status"); return s.getAttribute("role") === "status" && s.getAttribute("aria-live") === "polite"; })()`), null);
    check("the card did not take the keyboard focus (the message box keeps it)", await evalJs(`${SR}.activeElement === ${q(".input")}`), await evalJs(`String(${SR}.activeElement && ${SR}.activeElement.className)`));
    check("Send and Edit are at least 44px tall", await evalJs(`${btn("send")}.getBoundingClientRect().height >= 44 && ${btn("edit")}.getBoundingClientRect().height >= 44`), null);
    await shot("card-1280.png");
    await evalJs(`${btn("send")}.click(); true`);
    check("200: success line shown, buttons replaced, card locked",
      await waitFor(`${lastCard}.querySelector(".card-status").textContent.startsWith("Received.")`) &&
      await evalJs(`${lastCard}.querySelector(".card-actions").hidden === true && ${lastCard}.classList.contains("locked") && ${btn("send")}.disabled && ${btn("edit")}.disabled`), await cardText(".card-status"));
    check("200: the success text names the business from the config and keeps the demo note on a second, smaller line",
      await evalJs(`(() => { const s = ${lastCard}.querySelector(".card-status"); const n = s.querySelector(".card-status-note"); return s.firstChild.textContent === "Received. Thank you! Your details have been sent to the Menos Pay team." && !!n && n.textContent === "This is a demo, so no reply will come." && s.getAttribute("role") === "status"; })()`), await cardText(".card-status"));
    check("exactly one request reached /api/lead, with the exact lead from the server, the business id and an empty spam-trap field",
      mock.stats.leadRequests === 1 && JSON.stringify(mock.stats.lastLeadBody) === JSON.stringify({ business: "menospay", lead: LEAD, website: "" }), mock.stats.lastLeadBody);
    await evalJs(`${btn("send")}.click(); true`);
    await sleep(300);
    check("a card that was sent cannot be sent again", mock.stats.leadRequests === 1, mock.stats.leadRequests);
    await ask("how much is the fee?");
    await waitFor(`[...${qa(".b.bot")}].pop().textContent === "This is a mock reply."`);
    const hist = mock.stats.lastChatBody.history;
    check("the lead is not in the history sent back to the server (only { role, content } text)",
      Array.isArray(hist) && hist.every((h) => Object.keys(h).sort().join() === "content,role" && typeof h.content === "string") && !JSON.stringify(hist).includes("amina@example.com") && hist.length <= 10, hist);
    mock.server.close();
  }

  console.log("\n--- double click while slow");
  {
    const mock = await startMock("slow");
    await getCard(mock, "/", 1280);
    await evalJs(`(() => { const s = ${btn("send")}; s.click(); s.click(); return true; })()`);
    await sleep(500);
    check('while waiting: Send says "Sending..." and both buttons are disabled', await evalJs(`${btn("send")}.textContent === "Sending..." && ${btn("send")}.disabled && ${btn("edit")}.disabled`), await cardText(".card-btn"));
    await waitFor(`${lastCard}.classList.contains("locked")`, 8000);
    check("a double click sent only one request, which then succeeded", mock.stats.leadRequests === 1 && (await cardText(".card-status")).startsWith("Received. Thank you! Your details have been sent to the Menos Pay team."), mock.stats.leadRequests);
    mock.server.close();
  }

  const outcomes = [
    ["notconfigured", "501: not-set-up message, card locked, no success text",
      "Sending is not set up yet in this demo, so nothing was sent.", { send: true, edit: true }, true],
    ["rate", "429: try-later message, Send enabled again",
      "Too many submissions right now. Please try again later.", { send: false, edit: true }, false],
    ["invalid", "400: the server's field and reason, only Edit enabled",
      "Please check the email: is not a valid email address.", { send: true, edit: false }, false],
    ["fail", "502: could-not-send message, Send and Edit enabled",
      "Could not send your details. Please try again.", { send: false, edit: false }, false],
  ];
  for (const [mode, label, message, disabled, locked] of outcomes) {
    console.log(`\n--- ${mode}`);
    const mock = await startMock(mode);
    await getCard(mock, "/", 1280);
    await evalJs(`${btn("send")}.click(); true`);
    await waitFor(`${lastCard}.querySelector(".card-status").textContent !== ""`);
    const status = await cardText(".card-status");
    const state = await evalJs(`({ send: ${btn("send")}.disabled, edit: ${btn("edit")}.disabled, locked: ${lastCard}.classList.contains("locked"), label: ${btn("send")}.textContent })`);
    check(label, status === message && state.send === disabled.send && state.edit === disabled.edit && state.locked === locked && state.label === "Send" && !/received|thank you|have been sent/i.test(status), { status, state });
    if (mode === "fail") {
      await evalJs(`${btn("send")}.click(); true`);
      await sleep(500);
      check("502: Send can be tried again", mock.stats.leadRequests === 2, mock.stats.leadRequests);
    }
    mock.server.close();
  }

  console.log("\n--- network error / timeout path");
  {
    const mock = await startMock("ok");
    await getCard(mock, "/", 1280);
    mock.server.closeAllConnections();
    await new Promise((res) => mock.server.close(res));
    await evalJs(`${btn("send")}.click(); true`);
    check("server gone: could-not-send message, Send and Edit enabled",
      await waitFor(`${lastCard}.querySelector(".card-status").textContent === "Could not send your details. Please try again."`) &&
      await evalJs(`!${btn("send")}.disabled && !${btn("edit")}.disabled`), await cardText(".card-status"));
  }

  console.log("\n--- Edit, and only the latest card");
  {
    const mock = await startMock("ok");
    await getCard(mock, "/", 1280);
    await evalJs(`${btn("edit")}.click(); true`);
    check("Edit: card locked and greyed out, buttons disabled", await evalJs(`${lastCard}.classList.contains("locked") && ${btn("send")}.disabled && ${btn("edit")}.disabled`), null);
    check('Edit: the assistant says "Sure. Tell me what to change and I will show the details again."', await evalJs(`[...${qa(".b.bot")}].pop().textContent`) === "Sure. Tell me what to change and I will show the details again.", await evalJs(`[...${qa(".b.bot")}].pop().textContent`));
    check("Edit: focus goes to the message box", await evalJs(`${SR}.activeElement === ${q(".input")}`), null);
    check("Edit: nothing was sent", mock.stats.leadRequests === 0, mock.stats.leadRequests);
    await ask("here is the lead again");
    check("the next proposal creates a new card", await waitFor(`${qa(".card")}.length === 2`), await cardCount());
    check("only the latest card is active: the older one is locked, the new one is enabled",
      await evalJs(`(() => { const c = ${qa(".card")}; return c[0].classList.contains("locked") && c[0].querySelector(".card-send").disabled && c[0].querySelector(".card-edit").disabled && !c[1].classList.contains("locked") && !c[1].querySelector(".card-send").disabled; })()`), null);
    mock.server.close();
  }

  console.log("\n--- safety");
  {
    const mock = await startMock("ok");
    await openPage(mock, "/", 1280);
    await ask("xss test");
    await waitFor(`${qa(".card")}.length === 1`);
    check("HTML in lead fields is shown as plain text (no elements created, no dialog)",
      await evalJs(`${lastCard}.querySelector(".card-v").textContent === "<img src=x onerror=alert(1)>" && ${SR}.querySelectorAll("img, b").length === 0`) && !pageErrors.some((e) => /dialog/.test(e)), pageErrors);
    mock.server.close();
  }
  {
    const mock = await startMock("ok");
    await openPage(mock, "/plain.html", 1280);
    await ask("I want a demo, lead please");
    await waitFor(`${qa(".b.bot")}.length >= 2`);
    await sleep(300);
    check("a business without lead capture: the reply is shown and any lead object is ignored (no card)", (await cardCount()) === 0 && mock.stats.chatRequests === 1, await cardCount());
    mock.server.close();
  }

  console.log("\n--- success without the optional note");
  {
    const mock = await startMock("ok", { successNote: false });
    await getCard(mock, "/", 1280);
    await evalJs(`${btn("send")}.click(); true`);
    await waitFor(`${lastCard}.querySelector(".card-status").textContent.startsWith("Received.")`);
    check("no successNote in the config -> only the first line, no second line",
      await evalJs(`${lastCard}.querySelector(".card-status").textContent === "Received. Thank you! Your details have been sent to the Menos Pay team." && !${lastCard}.querySelector(".card-status-note")`), await cardText(".card-status"));
    mock.server.close();
  }

  console.log("\n--- the card at 360px wide");
  {
    const mock = await startMock("ok");
    await getCard(mock, "/", 360);
    check("card fits inside the chat panel (no sideways scroll), buttons at least 44px tall",
      await evalJs(`(() => { const m = ${q(".msgs")}; const c = ${lastCard}; return m.scrollWidth <= m.clientWidth && c.getBoundingClientRect().right <= m.getBoundingClientRect().right && document.documentElement.scrollWidth <= document.documentElement.clientWidth && ${btn("send")}.getBoundingClientRect().height >= 44; })()`), null);
    await evalJs(`${q(".msgs")}.scrollTop = ${q(".msgs")}.scrollHeight; true`);
    await shot("card-360.png");
    mock.server.close();
  }

  check("no uncaught page errors", pageErrors.length === 0, pageErrors);
  console.log(`\nscreenshots: ${shots}`);
  for (const f of fs.readdirSync(shots)) console.log("  " + path.join(shots, f));
  ws.close();
  chrome.kill();
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* Chrome may still hold files */ }
  return finish();
}

function finish() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 300);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
