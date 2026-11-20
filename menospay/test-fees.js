// Tests for fees.js. Run with: node test-fees.js (no dependencies).
const { calculateFee, MIN_AMOUNT, MAX_AMOUNT } = require("./fees.js");

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
}

function expectFee(name, input, fee, receive, ratePercent) {
  const r = calculateFee(input);
  check(name, r.ok === true && r.fee === fee && r.receive === receive && r.ratePercent === ratePercent, r);
}
function expectRejected(name, input, reasonPattern) {
  const r = calculateFee(input);
  const clean = typeof r.reason === "string" && r.reason.length > 0 && !/NaN|undefined/.test(r.reason);
  check(name, r.ok === false && clean && (!reasonPattern || reasonPattern.test(r.reason)), r);
}

console.log("--- the four examples from the price list");
expectFee("Starter, mobile money, 100,000 -> fee 2,500, receive 97,500", { amount: 100000, plan: "starter", method: "mobile" }, 2500, 97500, 2.5);
expectFee("Starter, card, 100,000 -> fee 3,200, receive 96,800", { amount: 100000, plan: "starter", method: "card" }, 3200, 96800, 3.2);
expectFee("Growth, mobile money, 100,000 -> fee 1,800, receive 98,200", { amount: 100000, plan: "growth", method: "mobile" }, 1800, 98200, 1.8);
expectFee("Growth, card, 100,000 -> fee 2,500, receive 97,500", { amount: 100000, plan: "growth", method: "card" }, 2500, 97500, 2.5);

console.log("--- rounding to the nearest whole shilling");
expectFee("Starter, mobile money, 1,001 -> fee 25 (25.025 rounds down)", { amount: 1001, plan: "starter", method: "mobile" }, 25, 976, 2.5);
expectFee("Starter, mobile money, 1,020 -> fee 26 (25.5 rounds up)", { amount: 1020, plan: "starter", method: "mobile" }, 26, 994, 2.5);
expectFee("Growth, card, 1,999 -> fee 50 (49.975 rounds up)", { amount: 1999, plan: "growth", method: "card" }, 50, 1949, 2.5);
const odd = calculateFee({ amount: 33333, plan: "growth", method: "card" });
check("fee is always a whole number and fee + receive = amount", odd.ok && Number.isInteger(odd.fee) && odd.fee + odd.receive === 33333, odd);

console.log("--- limits");
expectFee("exactly the minimum (1,000) is accepted", { amount: MIN_AMOUNT, plan: "starter", method: "mobile" }, 25, 975, 2.5);
expectFee("exactly the maximum (5,000,000) is accepted", { amount: MAX_AMOUNT, plan: "growth", method: "mobile" }, 90000, 4910000, 1.8);
expectRejected("999 is below the minimum -> not ok", { amount: 999, plan: "starter", method: "mobile" }, /minimum.*1,000/);
expectRejected("5,000,001 is above the maximum -> not ok", { amount: 5000001, plan: "starter", method: "mobile" }, /maximum.*5,000,000/);
expectRejected("0 -> not ok", { amount: 0, plan: "starter", method: "mobile" }, /minimum/);

console.log("--- typed text");
expectFee("text with thousands separators: '100,000'", { amount: "100,000", plan: "starter", method: "mobile" }, 2500, 97500, 2.5);
expectFee("text with spaces: '100 000'", { amount: "100 000", plan: "starter", method: "mobile" }, 2500, 97500, 2.5);
expectRejected("letters -> not ok", { amount: "abc", plan: "starter", method: "mobile" }, /digits only/);
expectRejected("digits mixed with letters -> not ok", { amount: "10k", plan: "starter", method: "mobile" }, /digits only/);
expectRejected("empty text -> not ok", { amount: "", plan: "starter", method: "mobile" }, /Enter an amount/);
expectRejected("spaces only -> not ok", { amount: "   ", plan: "starter", method: "mobile" }, /Enter an amount/);
expectRejected("missing amount -> not ok", { plan: "starter", method: "mobile" }, /Enter an amount/);
expectRejected("negative number as text -> not ok", { amount: "-5000", plan: "starter", method: "mobile" }, /digits only/);
expectRejected("decimal text -> not ok", { amount: "1000.50", plan: "starter", method: "mobile" }, /digits only/);
expectRejected("scientific notation -> not ok", { amount: "1e5", plan: "starter", method: "mobile" }, /digits only/);
expectRejected("NaN -> not ok", { amount: NaN, plan: "starter", method: "mobile" }, /Enter an amount/);
expectRejected("a decimal number -> not ok", { amount: 1000.5, plan: "starter", method: "mobile" }, /whole number/);
expectRejected("a huge digit string -> not ok, no NaN", { amount: "9".repeat(30), plan: "starter", method: "mobile" }, /too large/);
expectRejected("no input at all -> not ok", undefined, /Enter an amount/);

console.log("--- plan and method");
expectRejected("unknown plan -> not ok", { amount: 100000, plan: "enterprise", method: "mobile" }, /plan/i);
expectRejected("missing plan -> not ok", { amount: 100000, method: "mobile" }, /plan/i);
expectRejected("unknown method -> not ok", { amount: 100000, plan: "starter", method: "cash" }, /method/i);
expectFee("method 'mobile money' (with a space) is understood", { amount: 100000, plan: "Starter", method: "mobile money" }, 2500, 97500, 2.5);

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
