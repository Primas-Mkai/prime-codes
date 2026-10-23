// Menos Academy handbook assistant (demo page).
// Everything from the server or the model is inserted with textContent / createElement, never innerHTML.
(function () {
  "use strict";

  var BUSINESS = "menos-academy";
  var COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  var WIDE = window.matchMedia("(min-width: 960px)");
  var REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

  var form = document.getElementById("ask-form");
  var input = document.getElementById("question");
  var askButton = document.getElementById("ask-button");
  var counter = document.getElementById("counter");
  var chipsBox = document.getElementById("chips");
  var answerArea = document.getElementById("answer");
  var details = document.getElementById("handbook-details");
  var viewer = document.getElementById("viewer");

  var blocks = []; // { kind: "p" | "li" | "tr", el, text } for every paragraph, list item and table row
  var highlighted = null; // { block, original } so a highlight can be undone
  var busy = false;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---------- setup: theme, example questions, handbook text ----------

  function applyTheme(theme) {
    theme = theme && typeof theme === "object" ? theme : {};
    var names = { primary: "--primary", accent: "--accent", primaryText: "--primary-text", accentText: "--accent-text" };
    Object.keys(names).forEach(function (key) {
      if (typeof theme[key] === "string" && COLOR_RE.test(theme[key])) {
        document.documentElement.style.setProperty(names[key], theme[key]);
      }
    });
  }

  function getJson(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function loadConfig() {
    getJson("/api/config?business=" + BUSINESS).then(function (cfg) {
      applyTheme(cfg.theme);
      if (typeof cfg.documentTitle === "string" && cfg.documentTitle) {
        document.getElementById("doc-title").textContent = cfg.documentTitle;
      }
      var questions = Array.isArray(cfg.exampleQuestions) ? cfg.exampleQuestions.slice(0, 5) : [];
      questions.forEach(function (q) {
        if (typeof q !== "string") return;
        var chip = el("button", "chip", q);
        chip.type = "button";
        chip.addEventListener("click", function () {
          if (busy) return;
          input.value = q;
          updateCounter();
          ask();
        });
        chipsBox.appendChild(chip);
      });
    }).catch(function () { /* the page still works with the default colours and no chips */ });
  }

  function loadDocument() {
    getJson("/api/document?business=" + BUSINESS).then(function (doc) {
      viewer.textContent = "";
      viewer.appendChild(renderDocument(String(doc.text || "")));
    }).catch(function () {
      viewer.textContent = "";
      viewer.appendChild(el("p", "muted", "The handbook text could not be loaded."));
    });
  }

  // ---------- rendering the handbook (a small markdown subset) ----------

  function stripEmphasis(text) {
    return text.replace(/\*+/g, "").replace(/`/g, "");
  }

  function splitRow(line) {
    var cells = line.trim().split("|");
    if (cells.length && cells[0].trim() === "") cells.shift();
    if (cells.length && cells[cells.length - 1].trim() === "") cells.pop();
    return cells.map(function (c) { return stripEmphasis(c).trim(); });
  }

  var HEADING = /^(#{1,3})\s+(.*)$/;
  var TABLE_LINE = /^\s*\|/;
  var SEPARATOR = /^\s*\|?\s*:?-{2,}[\s|:-]*$/;
  var BULLET = /^-\s+(.*)$/;

  function renderDocument(text) {
    blocks = [];
    var frag = document.createDocumentFragment();
    var lines = text.replace(/\r\n/g, "\n").split("\n");
    var i = 0;

    function addTextBlock(parent, kind, tag, content) {
      var node = el(tag, "", content);
      parent.appendChild(node);
      blocks.push({ kind: kind, el: node, text: content });
      return node;
    }

    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i++; continue; }

      var h = HEADING.exec(line);
      if (h) {
        var title = stripEmphasis(h[2]).trim();
        var heading = el("h" + h[1].length, "", title);
        var num = /^(\d+(?:\.\d+)?)/.exec(title);
        if (num) heading.id = "sec-" + num[1].replace(".", "-");
        frag.appendChild(heading);
        i++;
        continue;
      }

      if (TABLE_LINE.test(line) && i + 1 < lines.length && SEPARATOR.test(lines[i + 1])) {
        var wrap = el("div", "table-wrap");
        var table = el("table");
        var thead = el("thead");
        var headRow = el("tr");
        splitRow(line).forEach(function (cell) { headRow.appendChild(el("th", "", cell)); });
        thead.appendChild(headRow);
        table.appendChild(thead);
        var tbody = el("tbody");
        i += 2;
        while (i < lines.length && TABLE_LINE.test(lines[i])) {
          var cells = splitRow(lines[i]);
          var tr = el("tr");
          cells.forEach(function (cell) { tr.appendChild(el("td", "", cell)); });
          tbody.appendChild(tr);
          blocks.push({ kind: "tr", el: tr, text: cells.join(" ") });
          i++;
        }
        table.appendChild(tbody);
        wrap.appendChild(table);
        frag.appendChild(wrap);
        continue;
      }

      if (BULLET.test(line)) {
        var ul = el("ul");
        while (i < lines.length && BULLET.test(lines[i])) {
          addTextBlock(ul, "li", "li", stripEmphasis(BULLET.exec(lines[i])[1]).trim());
          i++;
        }
        frag.appendChild(ul);
        continue;
      }

      // paragraph: consecutive plain lines
      var parts = [];
      while (i < lines.length && lines[i].trim() && !HEADING.test(lines[i]) && !BULLET.test(lines[i]) &&
             !(TABLE_LINE.test(lines[i]) && i + 1 < lines.length && SEPARATOR.test(lines[i + 1]))) {
        parts.push(lines[i].trim());
        i++;
      }
      addTextBlock(frag, "p", "p", stripEmphasis(parts.join(" ")));
    }
    return frag;
  }

  // ---------- highlighting the source quote ----------

  // Lower-case, straight quotes, no markdown marks, single spaces. map[k] = index in the original text.
  function normaliseWithMap(text) {
    var out = "";
    var map = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (c === "*" || c === "_" || c === "`") continue;
      if (c === "‘" || c === "’") c = "'";
      else if (c === "“" || c === "”") c = '"';
      if (/\s/.test(c)) {
        if (out === "" || out.charAt(out.length - 1) === " ") continue;
        out += " ";
        map.push(i);
      } else {
        out += c.toLowerCase();
        map.push(i);
      }
    }
    if (out.charAt(out.length - 1) === " ") { out = out.slice(0, -1); map.pop(); }
    return { text: out, map: map };
  }

  function normaliseQuote(quote) {
    return normaliseWithMap(String(quote).replace(/\s·\s/g, " ").replace(/^\s*-\s+/, "")).text;
  }

  function clearHighlight() {
    if (!highlighted) return;
    if (highlighted.block.kind === "tr") highlighted.block.el.classList.remove("hl-row");
    else highlighted.block.el.textContent = highlighted.block.text;
    highlighted = null;
  }

  // Returns the element to scroll to, or null if the quote was not found in the rendered handbook.
  function highlightQuote(quote) {
    clearHighlight();
    var wanted = normaliseQuote(quote);
    if (!wanted) return null;
    for (var b = 0; b < blocks.length; b++) {
      var block = blocks[b];
      var norm = normaliseWithMap(block.text);
      var at = norm.text.indexOf(wanted);
      if (at === -1) continue;
      highlighted = { block: block };
      if (block.kind === "tr") {
        block.el.classList.add("hl-row");
        return block.el;
      }
      var start = norm.map[at];
      var end = norm.map[at + wanted.length - 1] + 1;
      var mark = el("mark", "", block.text.slice(start, end));
      block.el.textContent = "";
      block.el.appendChild(document.createTextNode(block.text.slice(0, start)));
      block.el.appendChild(mark);
      block.el.appendChild(document.createTextNode(block.text.slice(end)));
      return mark;
    }
    return null;
  }

  // Scrolls only the handbook viewer (not the page) so the target is centred in it.
  function scrollViewerTo(target) {
    if (!target || viewer.offsetParent === null) return; // viewer hidden (folded handbook)
    var vr = viewer.getBoundingClientRect();
    var tr = target.getBoundingClientRect();
    var top = viewer.scrollTop + (tr.top - vr.top) - viewer.clientHeight / 2 + tr.height / 2;
    viewer.scrollTo({ top: Math.max(0, top), behavior: REDUCED_MOTION.matches ? "auto" : "smooth" });
  }

  // ---------- asking ----------

  function updateCounter() {
    var len = input.value.length;
    counter.hidden = len <= 400;
    counter.textContent = len + " / 500 characters";
  }

  function setBusy(isBusy) {
    busy = isBusy;
    input.disabled = isBusy;
    askButton.disabled = isBusy;
    Array.prototype.forEach.call(chipsBox.children, function (chip) { chip.disabled = isBusy; });
  }

  function showCard(card) {
    answerArea.textContent = "";
    answerArea.appendChild(card);
  }

  function answerCard(question, data) {
    var card = el("article", "card");
    var q = el("p", "question", question);
    var answer = el("p", "answer-text", String(data.answer || ""));

    if (data.found && data.source && data.source.quote) {
      card.appendChild(q);
      card.appendChild(answer);
      var source = el("div", "source");
      source.appendChild(el("p", "label", "Source: " + String(data.source.section || "Handbook")));
      source.appendChild(el("blockquote", "", String(data.source.quote)));
      var show = el("button", "btn-link", "Show in handbook");
      show.type = "button";
      source.appendChild(show);
      card.appendChild(source);

      // highlight straight away (inside the viewer only); jump to it only when the visitor asks
      var target = highlightQuote(data.source.quote);
      scrollViewerTo(target);
      show.addEventListener("click", function () {
        var t = highlightQuote(data.source.quote);
        if (!t) return;
        if (!WIDE.matches) details.open = true;
        t.scrollIntoView({ block: "center", behavior: REDUCED_MOTION.matches ? "auto" : "smooth" });
      });
    } else if (data.found === false && data.verified === false) {
      card.className = "card card-warning";
      card.appendChild(q);
      card.appendChild(el("p", "label", "Could not confirm"));
      card.appendChild(answer);
      clearHighlight();
    } else {
      card.className = "card card-neutral";
      card.appendChild(q);
      card.appendChild(el("p", "label", "Not covered in the handbook"));
      card.appendChild(answer);
      clearHighlight();
    }
    return card;
  }

  function errorCard(message) {
    var card = el("article", "card card-error");
    card.setAttribute("role", "alert");
    card.appendChild(el("p", "answer-text", message));
    return card;
  }

  function waitingCard() {
    var box = el("div", "waiting");
    var dots = el("span", "dots");
    dots.setAttribute("aria-hidden", "true");
    for (var d = 0; d < 3; d++) dots.appendChild(document.createElement("i"));
    var label = el("span", "", "Reading the handbook...");
    box.appendChild(dots);
    box.appendChild(label);
    return { box: box, label: label };
  }

  function ask() {
    var question = input.value.trim();
    if (busy || !question) return;

    setBusy(true);
    var waiting = waitingCard();
    showCard(waiting.box);
    var slowTimer = setTimeout(function () {
      waiting.label.textContent = "Reading the handbook... The server may be waking up. This can take up to a minute.";
    }, 8000);
    var controller = new AbortController();
    var abortTimer = setTimeout(function () { controller.abort(); }, 65000);

    fetch("/api/ask-document", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ business: BUSINESS, question: question }),
      signal: controller.signal
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.ok) {
          showCard(answerCard(question, data));
          return;
        }
        var message = typeof data.error === "string" && data.error ? data.error : "Something went wrong. Please try again.";
        var retry = parseInt(res.headers.get("Retry-After"), 10);
        if (res.status === 429 && retry > 0) {
          var minutes = Math.max(1, Math.ceil(retry / 60));
          message += " Try again in about " + minutes + (minutes === 1 ? " minute." : " minutes.");
        }
        clearHighlight();
        showCard(errorCard(message));
      });
    }).catch(function (err) {
      clearHighlight();
      showCard(errorCard(err && err.name === "AbortError"
        ? "That took too long. Please try again in a moment."
        : "Could not reach the server. Check your connection and try again."));
    }).then(function () {
      clearTimeout(slowTimer);
      clearTimeout(abortTimer);
      setBusy(false);
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    ask();
  });
  input.addEventListener("input", updateCounter);

  // On wide screens the handbook is always visible next to the ask panel; on narrow ones it folds away.
  function syncDetails() { if (WIDE.matches) details.open = true; }
  WIDE.addEventListener("change", syncDetails);
  details.querySelector("summary").addEventListener("click", function (e) { if (WIDE.matches) e.preventDefault(); });
  syncDetails();

  loadConfig();
  loadDocument();
})();
