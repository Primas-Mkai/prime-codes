// ============================================================
// CHAT WIDGET LOGIC - front-end only, no AI connected yet.
//
// What this file does right now:
//   1. Grabs references to the widget's HTML elements.
//   2. Opens/closes the chat panel when you click the bubble or the X.
//   3. Listens for the form being submitted (typing a message + Enter,
//      or clicking Send).
//   4. Displays the user's message immediately.
//   5. Calls getBotReply() to get a response, and displays that too.
//
// getBotReply() is currently FAKE - it just echoes back a canned line
// after a short delay, so the widget feels alive while we build it.
// In the next lesson, we replace only the INSIDE of that one function
// with a real call to a backend that talks to an AI model. Nothing else
// in this file needs to change when we do that - that's the whole point
// of keeping the "get a reply" logic in its own function.
// ============================================================

const launcher = document.getElementById("chat-launcher");
const panel = document.getElementById("chat-panel");
const closeBtn = document.getElementById("chat-close");
const messagesEl = document.getElementById("chat-messages");
const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");

let history = [];
let hasGreeted = false;

// --- Opening and closing the panel ---------------------------------

launcher.addEventListener("click", () => {
  const isOpen = panel.classList.toggle("open");
  if (isOpen) {
    input.focus();
    if (!hasGreeted) {
      hasGreeted = true;
      addMessage("bot", "Hi! I'm the assistant for The Daily Grind. (Not connected to real AI yet - that's next!)");
    }
  }
});

closeBtn.addEventListener("click", () => {
  panel.classList.remove("open");
});

// --- Sending a message -----------------------------------------------

form.addEventListener("submit", async (event) => {
  event.preventDefault(); // stop the page from reloading, which forms do by default

  const text = input.value.trim();
  if (!text) return;

  addMessage("user", text);
  input.value = "";

  // Show a "..." typing indicator while we "wait" for a reply.
  const typingEl = addMessage("bot", "...");

  const reply = await getBotReply(text);

  typingEl.textContent = reply;
});

// --- Adding a message bubble to the chat window -----------------------

function addMessage(sender, text) {
  const el = document.createElement("div");
  el.className = "msg " + sender; // "msg user" or "msg bot" - see style.css
  el.textContent = text;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight; // auto-scroll to the newest message
  return el;
}

// --- THIS is the function we will change together next lesson ---------
//
// Right now it fakes a delay and returns a canned reply, so you can see
// and feel the widget working end to end. Next lesson, we'll swap the
// inside of this function for a fetch() call to a small backend server,
// which is the piece that actually talks to an AI model - and we'll
// build that backend together, step by step, rather than me just
// handing it to you.

async function getBotReply(userMessage) {
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: userMessage, history }),
    });

    const data = await response.json();

    if (!response.ok) {
      return data.error || "Sorry, something went wrong. Please try again.";
    }

    // Remember this exchange so the AI has context for the next question.
    history.push({ role: "user", content: userMessage });
    history.push({ role: "assistant", content: data.reply });

    return data.reply;
  } catch (err) {
    return "Sorry, I'm having trouble connecting right now. Please try again in a moment.";
  }
}
