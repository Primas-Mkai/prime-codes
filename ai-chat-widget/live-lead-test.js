// Live check of lead capture with the real Gemini model.
// 1. Start the server in one terminal:  node server.js
// 2. In a second terminal, from the same folder:  node live-lead-test.js
// Optional: node live-lead-test.js http://localhost:3000
// It sends test conversations to the running server. It never sends an email (delivery is not built yet).
const BASE = process.argv[2] || "http://localhost:3000";
const BUSINESS = "menospay";

async function chat(history, message) {
  const r = await fetch(BASE + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ business: BUSINESS, history, message }),
    signal: AbortSignal.timeout(65000),
  });
  const d = await r.json();
  return { status: r.status, data: d };
}

function show(label, res) {
  console.log("\n=== " + label);
  console.log("status:", res.status);
  if (res.data.error) return console.log("error:", res.data.error);
  console.log("reply:", res.data.reply);
  console.log("lead:", res.data.lead ? JSON.stringify(res.data.lead) : "(none)");
}

(async () => {
  try {
    // Test 1: a normal question. Expect an answer, NO lead.
    show("1. Normal question (expect answer, no lead)", await chat([], "How much is the fee on a TZS 100,000 card payment on the Starter plan?"));

    // Test 2: a full lead in one message. Expect a lead object with the right fields.
    show(
      "2. Complete lead (expect a lead with Amina, amina@example.com, API)",
      await chat([], "Hi, I'd like a demo of your API. My name is Amina Juma, my email is amina@example.com, my company is Juma Shop.")
    );

    // Test 3: details given step by step. Expect questions first, then a lead at the end.
    let history = [];
    let msg = "I want to talk to someone about payouts for my staff salaries.";
    let res = await chat(history, msg);
    show("3a. Wants payouts, no details yet (expect questions, no lead)", res);
    history = [{ role: "user", content: msg }, { role: "assistant", content: res.data.reply || "" }];
    msg = "My name is Juma Hassan and my phone is +255 712 345 678.";
    res = await chat(history, msg);
    show("3b. Name and phone given (expect a lead for Payouts)", res);

    // Test 4: an invalid email. Expect NO lead and a reply asking for a correction.
    show("4. Bad email (expect no lead, a polite request to check the email)", await chat([], "Please pass my details on. I'm Sara Ali, email sara.ali-at-example, interested in Checkout."));

    // Test 5: a card number. Expect no lead and a warning not to share it.
    show("5. Card number (expect no lead, a warning)", await chat([], "I'm Peter Moshi, peter@example.com, interested in Checkout. My card is 4111 1111 1111 1111."));
  } catch (e) {
    console.log("failed:", e.message);
  }
})();