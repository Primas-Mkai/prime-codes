/* Embeddable chat widget.
   Usage: <script src="https://<server>/widget.js" data-business="<id>" defer></script>
   No globals, no storage, no external requests except to the server that served this file. */
(function () {
  "use strict";
  var script = document.currentScript; // must be captured before anything else runs
  try {
    if (!script) return;
    var businessId = script.getAttribute("data-business");
    if (!businessId) {
      console.warn("[chat widget] data-business is missing; the widget will not start.");
      return;
    }
    var api;
    try {
      api = (script.getAttribute("data-api") || new URL(script.src).origin).replace(/\/+$/, "");
    } catch (e) {
      return;
    }
    if (document.getElementById("ai-chat-widget-host")) return;

    var DEFAULTS = { primary: "#1F4A3A", accent: "#C9A15A", primaryText: "#FFFFFF", accentText: "#1C1B19" };
    var COLOR_RE = /^#[0-9a-fA-F]{6}$/;
    var MSG_NETWORK = "I can't reach the assistant right now. Please try again in a moment.";
    var MSG_GENERIC = "Sorry, something went wrong. Please try again.";

    function color(value, fallback) {
      return typeof value === "string" && COLOR_RE.test(value) ? value : fallback;
    }

    function fetchJson(url, options, timeoutMs) {
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
      options = options || {};
      options.signal = controller.signal;
      return fetch(url, options).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          clearTimeout(timer);
          return { ok: res.ok, data: data };
        });
      }, function (err) { clearTimeout(timer); throw err; });
    }

    function loadConfig(attempt) {
      var url = api + "/api/config?business=" + encodeURIComponent(businessId);
      return fetchJson(url, {}, 45000).then(function (r) {
        if (!r.ok) throw new Error("config " + r.data.error);
        return r.data;
      }).catch(function (err) {
        if (attempt >= 3) throw err;
        return new Promise(function (resolve) { setTimeout(resolve, 3000); }).then(function () {
          return loadConfig(attempt + 1);
        });
      });
    }

    var CSS = [
      ":host{all:initial}",
      "*{box-sizing:border-box}",
      "[hidden]{display:none!important}",
      ".w{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.45;color:#1C1B19}",
      "button{font:inherit;cursor:pointer}",
      "button:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:2px}",
      ".launcher{position:fixed;right:16px;bottom:16px;height:58px;min-width:58px;padding:0;display:flex;align-items:center;justify-content:center;gap:10px;border-radius:999px;border:2px solid var(--accent);background:var(--primary);color:var(--primary-text);box-shadow:0 8px 24px rgba(0,0,0,.25);font-weight:600;font-size:16px}",
      ".launcher .label{display:none}",
      ".launcher .i-close{display:none}",
      ".launcher[aria-expanded=true] .i-open{display:none}",
      ".launcher[aria-expanded=true] .i-close{display:block}",
      ".panel{position:fixed;left:12px;right:12px;top:12px;bottom:84px;display:flex;flex-direction:column;overflow:hidden;border-radius:16px;background:#F6F6F4;box-shadow:0 24px 64px rgba(0,0,0,.3)}",
      ".head{display:flex;align-items:center;gap:12px;padding:12px 8px 12px 16px;background:var(--primary);color:var(--primary-text)}",
      ".avatar{width:40px;height:40px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--accent);color:var(--accent-text)}",
      ".titles{flex:1;min-width:0;line-height:1.25}",
      ".title{font-size:16px;font-weight:700;overflow-wrap:anywhere}",
      ".sub{font-size:13px;opacity:.8}",
      ".close{width:44px;height:44px;flex:none;border:0;border-radius:12px;background:transparent;color:inherit;display:flex;align-items:center;justify-content:center}",
      ".close:hover{background:rgba(255,255,255,.14)}",
      ".msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}",
      ".b{max-width:85%;padding:10px 14px;overflow-wrap:anywhere;white-space:pre-wrap}",
      ".bot{align-self:flex-start;background:#fff;color:#1C1B19;border-radius:16px 16px 16px 4px;box-shadow:0 1px 2px rgba(0,0,0,.08)}",
      ".me{align-self:flex-end;background:var(--primary);color:var(--primary-text);border-radius:16px 16px 4px 16px}",
      ".err{background:#FDECEA;color:#8A1F11}",
      ".dots{display:inline-flex;gap:4px;align-items:center;height:1.45em}",
      ".dots i{width:7px;height:7px;border-radius:50%;background:#8a8a85;animation:blink 1.2s infinite both}",
      ".dots i:nth-child(2){animation-delay:.2s}.dots i:nth-child(3){animation-delay:.4s}",
      "@keyframes blink{0%,80%,100%{opacity:.25}40%{opacity:1}}",
      ".sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}",
      ".note{padding:6px 16px;font-size:12px;color:#6b6b66;background:#F6F6F4}",
      ".form{display:flex;gap:8px;padding:12px;background:#fff;border-top:1px solid #E3E3DE}",
      ".input{flex:1;min-width:0;height:46px;padding:0 14px;border:1px solid #CFCFC8;border-radius:12px;font:inherit;color:#1C1B19;background:#fff}",
      ".input:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px var(--primary)}",
      ".send{width:46px;min-height:46px;height:46px;flex:none;border:0;border-radius:12px;background:var(--accent);color:var(--accent-text);display:flex;align-items:center;justify-content:center}",
      ".send:disabled{opacity:.5;cursor:default}",
      "@media (min-width:900px){",
      ".launcher{right:24px;bottom:24px;padding:0 24px}",
      ".launcher .label{display:inline}",
      ".launcher[aria-expanded=true]{padding:0;width:58px}",
      ".launcher[aria-expanded=true] .label{display:none}",
      ".panel{left:auto;top:auto;right:24px;bottom:94px;width:360px;height:540px;max-height:calc(100vh - 120px)}",
      "}",
      "@media (prefers-reduced-motion:reduce){.dots i{animation:none;opacity:.6}}"
    ].join("\n");

    var ICON_BUBBLE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.7 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>';
    var ICON_CLOSE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    var ICON_SEND = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

    function el(tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function icon(markup, className) {
      var span = el("span", className);
      span.innerHTML = markup; // static markup written in this file only
      return span;
    }

    function build(cfg) {
      var theme = cfg.theme && typeof cfg.theme === "object" ? cfg.theme : {};
      var assistantName = typeof cfg.assistantName === "string" && cfg.assistantName ? cfg.assistantName : "Assistant";
      var buttonLabel = typeof cfg.buttonLabel === "string" && cfg.buttonLabel ? cfg.buttonLabel : "Ask us anything";
      var greeting = typeof cfg.greeting === "string" ? cfg.greeting : "";

      var host = document.createElement("div");
      host.id = "ai-chat-widget-host";
      host.style.cssText = "all:initial;position:fixed;z-index:2147483000;";
      var root = host.attachShadow({ mode: "open" });
      var style = document.createElement("style");
      style.textContent = CSS;
      root.appendChild(style);

      var wrap = el("div", "w");
      wrap.style.setProperty("--primary", color(theme.primary, DEFAULTS.primary));
      wrap.style.setProperty("--accent", color(theme.accent, DEFAULTS.accent));
      wrap.style.setProperty("--primary-text", color(theme.primaryText, DEFAULTS.primaryText));
      wrap.style.setProperty("--accent-text", color(theme.accentText, DEFAULTS.accentText));
      root.appendChild(wrap);

      // launcher
      var launcher = el("button", "launcher");
      launcher.type = "button";
      launcher.setAttribute("aria-expanded", "false");
      launcher.setAttribute("aria-controls", "panel");
      launcher.setAttribute("aria-label", buttonLabel);
      launcher.appendChild(icon(ICON_BUBBLE, "i-open"));
      launcher.appendChild(icon(ICON_CLOSE, "i-close"));
      launcher.appendChild(el("span", "label", buttonLabel));
      wrap.appendChild(launcher);

      // panel
      var panel = el("div", "panel");
      panel.id = "panel";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", assistantName);
      panel.hidden = true;

      var head = el("div", "head");
      var avatar = icon(ICON_BUBBLE, "avatar");
      var titles = el("div", "titles");
      titles.appendChild(el("div", "title", assistantName));
      titles.appendChild(el("div", "sub", "AI assistant"));
      var closeBtn = el("button", "close");
      closeBtn.type = "button";
      closeBtn.setAttribute("aria-label", "Close chat");
      closeBtn.innerHTML = ICON_CLOSE;
      head.appendChild(avatar);
      head.appendChild(titles);
      head.appendChild(closeBtn);

      var msgs = el("div", "msgs");
      msgs.setAttribute("aria-live", "polite");
      var note = el("div", "note", "Automated answers. Please don't share passwords or payment details.");

      var form = el("form", "form");
      var input = el("input", "input");
      input.type = "text";
      input.maxLength = 500;
      input.placeholder = "Type your message…";
      input.setAttribute("aria-label", "Your message");
      input.autocomplete = "off";
      var send = el("button", "send");
      send.type = "submit";
      send.setAttribute("aria-label", "Send");
      send.innerHTML = ICON_SEND;
      form.appendChild(input);
      form.appendChild(send);

      panel.appendChild(head);
      panel.appendChild(msgs);
      panel.appendChild(note);
      panel.appendChild(form);
      wrap.appendChild(panel);

      var history = []; // in memory only: { role, content }

      function addBubble(kind, text) {
        var b = el("div", "b " + kind, text);
        msgs.appendChild(b);
        msgs.scrollTop = msgs.scrollHeight;
        return b;
      }
      function showTyping() {
        var b = el("div", "b bot");
        b.setAttribute("role", "status");
        var dots = el("span", "dots");
        dots.setAttribute("aria-hidden", "true");
        dots.appendChild(document.createElement("i"));
        dots.appendChild(document.createElement("i"));
        dots.appendChild(document.createElement("i"));
        b.appendChild(dots);
        b.appendChild(el("span", "sr", "The assistant is typing"));
        msgs.appendChild(b);
        msgs.scrollTop = msgs.scrollHeight;
        return b;
      }

      function setOpen(open) {
        panel.hidden = !open;
        launcher.setAttribute("aria-expanded", String(open));
        if (open) {
          input.focus();
          msgs.scrollTop = msgs.scrollHeight;
        }
      }
      launcher.addEventListener("click", function () { setOpen(panel.hidden); });
      closeBtn.addEventListener("click", function () { setOpen(false); launcher.focus(); });
      wrap.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && !panel.hidden) { setOpen(false); launcher.focus(); }
      });

      if (greeting) addBubble("bot", greeting);

      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var text = input.value.trim();
        if (!text || send.disabled) return;
        addBubble("me", text);
        input.value = "";
        send.disabled = true;
        var typing = showTyping();

        fetchJson(api + "/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, history: history.slice(-10), business: businessId })
        }, 30000).then(function (r) {
          typing.remove();
          if (r.ok && typeof r.data.reply === "string") {
            addBubble("bot", r.data.reply);
            history.push({ role: "user", content: text }, { role: "assistant", content: r.data.reply });
            history = history.slice(-10);
          } else {
            addBubble("bot err", typeof r.data.error === "string" ? r.data.error : MSG_GENERIC);
          }
        }, function () {
          typing.remove();
          addBubble("bot err", MSG_NETWORK);
        }).then(function () {
          send.disabled = false;
          if (!panel.hidden) input.focus();
        });
      });

      document.body.appendChild(host);
    }

    function start() {
      loadConfig(1).then(function (cfg) {
        try { build(cfg || {}); } catch (e) { console.warn("[chat widget] could not start."); }
      }, function () {
        console.warn("[chat widget] could not load its settings; the widget will not appear.");
      });
    }

    if (document.readyState === "complete") start();
    else window.addEventListener("load", start);
  } catch (e) {
    /* never break the host page */
  }
})();
