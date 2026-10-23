// Dev-only browser check for /handbook/. Not needed at runtime. No npm packages:
// it drives an installed Chrome/Edge through the DevTools protocol (Node's built-in WebSocket).
//   node check-handbook-ui.js
// The server runs in this process with a FAKE model, so no API key is needed.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

process.env.RATE_LIMIT_MAX = "500";
process.env.GEMINI_API_KEY = "dummy";
const app = require("./server.js");

const GOOD_QUOTE = "If a term fee is still unpaid 14 days after the due date, a late fee of TZS 50,000 is added to the invoice.";
app.hooks.askGemini = async (messages) => {
  const q = messages[messages.length - 1].content.toLowerCase();
  const reply = (o) => JSON.stringify(o);
  if (q.includes("late fee")) return reply({ found: true, answer: "The late fee is TZS 50,000.", quote: GOOD_QUOTE });
  if (q.includes("term 2")) return reply({ found: true, answer: "Term 2 starts on 26 April 2027.", quote: "| Term 2   | Monday 26 April 2027 | Friday 2 July 2027 |" });
  if (q.includes("scholarship")) return reply({ found: false, answer: "The handbook does not mention scholarships.", quote: "" });
  if (q.includes("unverifiable")) return reply({ found: true, answer: "Invented.", quote: "This sentence is not in the handbook anywhere at all." });
  throw new Error("AI provider failed (last status 503)"); // anything else: a fake 502
};

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => fs.existsSync(p));

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!CHROME) {
    console.log("No Chrome/Edge found; cannot run the browser check.");
    process.exit(2);
  }
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "handbook-ui-"));
  const shots = fs.mkdtempSync(path.join(os.tmpdir(), "handbook-shots-"));
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" });

  let port;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    try { port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch (e) { /* not yet */ }
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));

  let nextId = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === "Runtime.exceptionThrown") consoleErrors.push("exception: " + msg.params.exceptionDetails.text);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") consoleErrors.push(msg.params.args.map((a) => a.value || a.description).join(" "));
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") consoleErrors.push(msg.params.entry.text);
  };
  const send = (method, params = {}) => new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  };
  const waitFor = async (expression, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) { if (await evalJs(expression)) return true; await sleep(100); }
    return false;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");

  const ask = (q) => evalJs(`(() => { const i = document.getElementById("question"); i.value = ${JSON.stringify(q)}; document.getElementById("ask-form").requestSubmit(); return true; })()`);
  const settled = () => waitFor(`!document.getElementById("question").disabled && !document.querySelector(".waiting")`);

  for (const [width, label] of [[1280, "desktop"], [390, "mobile"]]) {
    console.log(`\n--- ${width}px wide (${label})`);
    consoleErrors.length = 0;
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    await send("Page.navigate", { url: `${base}/handbook/` });
    check(`${width}: chips appear (3)`, await waitFor(`document.querySelectorAll(".chip").length === 3`), null);
    check(`${width}: handbook text rendered`, await waitFor(`document.querySelectorAll("#viewer h2").length >= 8 && document.querySelectorAll("#viewer table").length >= 1`), null);
    check(`${width}: no horizontal scroll`, await evalJs(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), await evalJs(`[document.documentElement.scrollWidth, document.documentElement.clientWidth]`));
    check(`${width}: handbook ${width >= 960 ? "open beside the form" : "folded in a closed <details>"}`,
      await evalJs(`document.getElementById("handbook-details").open === ${width >= 960}`), null);
    check(`${width}: page title`, (await evalJs(`document.title`)) === "Menos Academy: Parent Handbook assistant (demo)", null);

    // chip -> verified answer card with Source block and a <mark> in the handbook
    await evalJs(`document.querySelectorAll(".chip")[0].click(); true`);
    check(`${width}: chip click -> answer card with Source block`, await waitFor(`!!document.querySelector("#answer .source blockquote")`), null);
    await settled();
    check(`${width}: source label shows the section`, (await evalJs(`document.querySelector("#answer .source .label").textContent`)) === "Source: 3.4 Late payment", await evalJs(`document.querySelector("#answer .source .label").textContent`));
    check(`${width}: <mark> exists in the handbook viewer`, await evalJs(`!!document.querySelector("#viewer mark") && document.querySelector("#viewer mark").textContent.includes("TZS 50,000")`), null);
    if (width >= 960) {
      await sleep(1500); // the viewer scrolls smoothly to the highlight
      check(`${width}: viewer scrolled so the highlight is visible`, await evalJs(`(() => { const v = document.getElementById("viewer").getBoundingClientRect(); const m = document.querySelector("#viewer mark").getBoundingClientRect(); return m.top >= v.top && m.bottom <= v.bottom; })()`), await evalJs(`document.getElementById("viewer").scrollTop`));
    }
    if (width < 960) {
      check(`${width}: automatic highlight did not open the folded handbook`, await evalJs(`document.getElementById("handbook-details").open === false`), null);
      await evalJs(`document.querySelector("#answer .btn-link").click(); true`);
      check(`${width}: "Show in handbook" opens the handbook`, await waitFor(`document.getElementById("handbook-details").open === true`), null);
    }
    await send("Page.captureScreenshot", {}).then((r) => fs.writeFileSync(path.join(shots, `handbook-${width}-answer.png`), Buffer.from(r.result.data, "base64")));

    // table row highlight
    await ask("When does term 2 start?");
    await waitFor(`!!document.querySelector("#answer .source blockquote")`);
    await settled();
    check(`${width}: table-row quote shown cleaned`, (await evalJs(`document.querySelector("#answer .source blockquote").textContent`)) === "Term 2 \u00B7 Monday 26 April 2027 \u00B7 Friday 2 July 2027", await evalJs(`document.querySelector("#answer .source blockquote").textContent`));
    check(`${width}: table row highlighted (tr.hl-row), old <mark> removed`, await evalJs(`!!document.querySelector("#viewer tr.hl-row") && !document.querySelector("#viewer mark")`), null);

    // not covered
    await ask("Does the school offer scholarships?");
    await settled();
    check(`${width}: found:false -> "Not covered in the handbook", no source block`, await evalJs(`document.querySelector("#answer .label").textContent === "Not covered in the handbook" && !document.querySelector("#answer .source")`), await evalJs(`document.getElementById("answer").textContent`));

    // could not confirm
    await ask("an unverifiable question");
    await settled();
    check(`${width}: unverifiable quote -> "Could not confirm" card`, await evalJs(`document.querySelector("#answer .label").textContent === "Could not confirm" && !document.querySelector("#answer .source")`), await evalJs(`document.getElementById("answer").textContent`));

    // empty question is not sent
    const before = await evalJs(`document.getElementById("answer").textContent`);
    await ask("   ");
    await sleep(300);
    check(`${width}: whitespace-only question is not sent`, (await evalJs(`document.getElementById("answer").textContent`)) === before, null);

    // character counter only above 400 characters
    await evalJs(`(() => { const i = document.getElementById("question"); i.value = "x".repeat(401); i.dispatchEvent(new Event("input")); return true; })()`);
    check(`${width}: counter appears over 400 characters`, await evalJs(`!document.getElementById("counter").hidden`), null);
    await evalJs(`(() => { const i = document.getElementById("question"); i.value = "x"; i.dispatchEvent(new Event("input")); return true; })()`);
    check(`${width}: counter hidden again`, await evalJs(`document.getElementById("counter").hidden`), null);

    const errorsSoFar = consoleErrors.filter((e) => !/Failed to load resource/.test(e));

    // fake 502
    await ask("tell me something else");
    await settled();
    check(`${width}: fake 502 shows the server's error text`, await evalJs(`document.querySelector("#answer .card-error").textContent.includes("busy right now")`), await evalJs(`document.getElementById("answer").textContent`));
    await send("Page.captureScreenshot", {}).then((r) => fs.writeFileSync(path.join(shots, `handbook-${width}-error.png`), Buffer.from(r.result.data, "base64")));

    check(`${width}: no console errors (the browser's own "Failed to load resource" line for the fake 502 is ignored)`,
      errorsSoFar.length === 0 && consoleErrors.filter((e) => !/Failed to load resource/.test(e)).length === 0, consoleErrors);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log("Screenshots saved in: " + shots);
  for (const f of fs.readdirSync(shots)) console.log("  " + path.join(shots, f));

  ws.close();
  chrome.kill();
  app.server.close();
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* Chrome may still hold files */ }
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 300);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
