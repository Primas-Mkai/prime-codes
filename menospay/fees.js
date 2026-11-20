// Menos Pay fee calculator: one pure function, used by the page (window.MenosFees) and by test-fees.js (require).
// All numbers come from the demo business facts: Starter 2.5%, Growth 1.8%, card +0.7%,
// minimum single payment TZS 1,000, maximum TZS 5,000,000, fee rounded to the nearest whole shilling.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MenosFees = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MIN_AMOUNT = 1000;
  var MAX_AMOUNT = 5000000;
  // Rates are kept in tenths of a percent so the arithmetic stays in whole numbers (no floating-point drift).
  var PLAN_TENTHS = { starter: 25, growth: 18 };
  var CARD_EXTRA_TENTHS = 7;

  function formatTzs(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  // Accepts a number or text such as "100000", "100,000" or "100 000". Returns a whole number or an error reason.
  function parseAmount(input) {
    if (typeof input === "number") {
      if (!isFinite(input)) return { reason: "Enter an amount in TZS." };
      if (Math.floor(input) !== input || input < 0) return { reason: "Use a whole number of shillings, for example 100000." };
      return { value: input };
    }
    if (typeof input !== "string") return { reason: "Enter an amount in TZS." };
    var text = input.replace(/[,\s]/g, "");
    if (text === "") return { reason: "Enter an amount in TZS." };
    if (!/^\d+$/.test(text)) return { reason: "Use digits only, for example 100000." };
    if (text.length > 12) return { reason: "That amount is too large. The maximum single payment is TZS " + formatTzs(MAX_AMOUNT) + "." };
    return { value: Number(text) };
  }

  // calculateFee({ amount, plan: "starter" | "growth", method: "mobile" | "card" })
  // returns { ok: true, fee, receive, ratePercent } or { ok: false, reason }.
  function calculateFee(options) {
    options = options || {};
    var parsed = parseAmount(options.amount);
    if (parsed.reason) return { ok: false, reason: parsed.reason };
    var amount = parsed.value;

    var plan = String(options.plan || "").toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(PLAN_TENTHS, plan)) {
      return { ok: false, reason: "Choose a plan: Starter or Growth." };
    }
    var method = String(options.method || "").toLowerCase().replace(/[\s_-]+/g, "");
    if (method !== "mobile" && method !== "mobilemoney" && method !== "card") {
      return { ok: false, reason: "Choose a payment method: mobile money or card." };
    }

    if (amount < MIN_AMOUNT) return { ok: false, reason: "The minimum single payment is TZS " + formatTzs(MIN_AMOUNT) + "." };
    if (amount > MAX_AMOUNT) return { ok: false, reason: "The maximum single payment is TZS " + formatTzs(MAX_AMOUNT) + "." };

    var tenths = PLAN_TENTHS[plan] + (method === "card" ? CARD_EXTRA_TENTHS : 0);
    var fee = Math.round((amount * tenths) / 1000);
    return { ok: true, fee: fee, receive: amount - fee, ratePercent: tenths / 10 };
  }

  return { calculateFee: calculateFee, formatTzs: formatTzs, MIN_AMOUNT: MIN_AMOUNT, MAX_AMOUNT: MAX_AMOUNT };
});
