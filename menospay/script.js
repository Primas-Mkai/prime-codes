// Menos Pay demo page: menu, fee calculator, footer year, and the "Try the demo assistant" hint.
// Nothing here collects or sends any data.
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // ---------- footer year (never hard-coded in the HTML) ----------
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  // ---------- mobile menu ----------
  var menuBtn = document.getElementById("menu-btn");
  var nav = document.getElementById("site-nav");
  var menuIcon = document.getElementById("menu-icon-path");
  var BARS = "M3 6h14M3 10h14M3 14h14";
  var CROSS = "M5 5l10 10M15 5L5 15";

  function setMenu(open) {
    menuBtn.setAttribute("aria-expanded", String(open));
    nav.classList.toggle("open", open);
    menuIcon.setAttribute("d", open ? CROSS : BARS);
  }
  menuBtn.addEventListener("click", function () {
    setMenu(menuBtn.getAttribute("aria-expanded") !== "true");
  });
  nav.addEventListener("click", function (e) {
    if (e.target.closest("a")) setMenu(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && menuBtn.getAttribute("aria-expanded") === "true") {
      setMenu(false);
      menuBtn.focus();
    }
  });
  window.matchMedia("(min-width: 900px)").addEventListener("change", function (e) {
    if (e.matches) setMenu(false);
  });

  // ---------- fee calculator ----------
  var amountInput = document.getElementById("amount");
  var resultBox = document.getElementById("calc-result");

  function selected(name) {
    var el = document.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : "";
  }

  function row(label, value, className) {
    var wrap = document.createElement("div");
    if (className) wrap.className = className;
    var dt = document.createElement("dt");
    dt.textContent = label;
    var dd = document.createElement("dd");
    dd.textContent = value;
    wrap.appendChild(dt);
    wrap.appendChild(dd);
    return wrap;
  }

  function showMessage(className, text) {
    resultBox.textContent = "";
    var p = document.createElement("p");
    p.className = className;
    p.textContent = text;
    resultBox.appendChild(p);
  }

  function render() {
    var raw = amountInput.value;
    if (raw.trim() === "") {
      showMessage("calc-empty", "Enter an amount to see the fee.");
      return;
    }
    var result = window.MenosFees.calculateFee({ amount: raw, plan: selected("plan"), method: selected("method") });
    if (!result.ok) {
      showMessage("calc-error", result.reason);
      return;
    }
    var amount = Number(raw.replace(/[,\s]/g, ""));
    var fmt = window.MenosFees.formatTzs;
    var list = document.createElement("dl");
    list.className = "calc-rows";
    list.appendChild(row("Payment amount", "TZS " + fmt(amount)));
    list.appendChild(row("Rate applied", result.ratePercent + "%"));
    list.appendChild(row("Checkout fee", "TZS " + fmt(result.fee)));
    list.appendChild(row("You receive", "TZS " + fmt(result.receive), "big"));
    resultBox.textContent = "";
    resultBox.appendChild(list);
  }

  // Show thousands separators while typing, keeping the cursor next to the same digit.
  function formatAsTyped() {
    var value = amountInput.value;
    if (!/^[\d,\s]*$/.test(value)) return; // letters etc. are left alone so the message can explain
    var caret = amountInput.selectionStart;
    var digitsBeforeCaret = value.slice(0, caret === null ? value.length : caret).replace(/\D/g, "").length;
    var digits = value.replace(/\D/g, "");
    var formatted = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    if (formatted === value) return;
    amountInput.value = formatted;
    var pos = 0;
    var seen = 0;
    while (pos < formatted.length && seen < digitsBeforeCaret) {
      if (/\d/.test(formatted.charAt(pos))) seen++;
      pos++;
    }
    amountInput.setSelectionRange(pos, pos);
  }

  amountInput.addEventListener("input", function () {
    formatAsTyped();
    render();
  });
  Array.prototype.forEach.call(document.querySelectorAll('input[name="plan"], input[name="method"]'), function (input) {
    input.addEventListener("change", render);
  });

  // ---------- "Try the demo assistant" ----------
  // The chat widget has no way to be opened from the page, so this scrolls to the bottom and points at the
  // chat button in the corner.
  var tryBtn = document.getElementById("try-assistant");
  var hint = document.getElementById("assistant-hint");
  var hintClose = document.getElementById("hint-close");
  var hintTimer = null;

  function hideHint() {
    hint.hidden = true;
    clearTimeout(hintTimer);
  }
  tryBtn.addEventListener("click", function () {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: reduceMotion.matches ? "auto" : "smooth" });
    hint.hidden = false;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(hideHint, 15000);
    hintClose.focus({ preventScroll: true });
  });
  hintClose.addEventListener("click", function () {
    hideHint();
    tryBtn.focus({ preventScroll: true });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !hint.hidden) hideHint();
  });
})();
