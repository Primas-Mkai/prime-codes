// Safety checks before pushing. Run with: node check-site.js (no dependencies).
// It catches a forgotten localhost address, a hard-coded year, a missing demo banner, a missing or wrong
// chat script tag, any <form>, and any web address in index.html other than the chat server's.
const fs = require("fs");
const path = require("path");

const CHAT_ORIGIN = "https://prime-codes.onrender.com";
const BUSINESS_ID = "menospay";

const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
const html = read("index.html");
const js = read("script.js");

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}

// 1. No localhost anywhere in the page's own files.
for (const [file, text] of [["index.html", html], ["script.js", js], ["fees.js", read("fees.js")], ["styles.css", read("styles.css")]]) {
  const hit = text.match(/localhost|127\.0\.0\.1/i);
  check(`${file} has no localhost / 127.0.0.1`, !hit, `found "${hit && hit[0]}"`);
}

// 2. No hard-coded year in the HTML (the footer year is filled in by script.js).
const year = html.match(/20\d\d/);
check("index.html has no hard-coded year (20xx)", !year, `found "${year && year[0]}"`);
check("script.js fills in the footer year", /getFullYear\(\)/.test(js) && /id="year"/.test(html), "no getFullYear() or no #year");

// 3. The demo banner.
check('the banner says "fictional demo company"', /fictional demo company/i.test(html), "text missing");

// 4. The chat script tag.
const tags = html.match(/<script\b[^>]*widget\.js[^>]*>/gi) || [];
const tag = tags[0] || "";
check("exactly one chat script tag", tags.length === 1, `${tags.length} found`);
check(`the chat script tag loads ${CHAT_ORIGIN}/widget.js`, tag.includes(`src="${CHAT_ORIGIN}/widget.js"`), tag || "missing");
check(`the chat script tag has data-business="${BUSINESS_ID}"`, tag.includes(`data-business="${BUSINESS_ID}"`), tag || "missing");
check("the chat script tag comes after the page's own scripts, just before </body>", /<script\b[^>]*widget\.js[^>]*><\/script>\s*<\/body>/i.test(html), "not the last thing before </body>");

// 5. No <form>: nothing on this page collects personal or payment details.
check("the page has no <form> element", !/<form[\s>]/i.test(html), "a <form> was found");

// 6. No other web addresses in index.html.
const urls = (html.match(/https?:\/\/[^\s"'<>)]+/gi) || []).filter((u) => !u.startsWith(CHAT_ORIGIN));
check(`no http(s) address in index.html other than ${CHAT_ORIGIN}`, urls.length === 0, urls.join(", "));

console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
process.exitCode = failed ? 1 : 0;
