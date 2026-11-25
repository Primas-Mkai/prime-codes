// Lead delivery: emails a confirmed lead through Resend, as plain text.
// Settings are read from the environment at CALL time:
//   RESEND_API_KEY   the Resend key (required)
//   LEAD_TO_EMAIL    the one address that receives leads (required)
//   LEAD_FROM_EMAIL  optional sender; default is "<business name> <onboarding@resend.dev>"
// Errors carry a code and a generic message only. The key, the lead, the recipient address and Resend's
// answer are never put in an error message or a log line.
const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 10000;

function deliveryError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function plausibleEmail(value) {
  return typeof value === "string" && value.length <= 254 && /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/.test(value);
}

// One line of plain text: control characters (including CR and LF) become spaces.
function oneLine(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").replace(/ {2,}/g, " ").trim();
}

function buildEmail(lead, business, to) {
  const businessName = oneLine(business && business.config && business.config.name).replace(/[<>"]/g, "") || "Lead notifications";
  const configuredFrom = oneLine(process.env.LEAD_FROM_EMAIL);
  const from = configuredFrom || `${businessName} <onboarding@resend.dev>`;

  const subject = `New ${businessName} lead: ${oneLine(lead.name)}`.slice(0, 120);

  const lines = [`New lead from the ${businessName} website chat.`, ""];
  for (const [key, label] of [["name", "Name"], ["email", "Email"], ["phone", "Phone"], ["company", "Company"], ["interest", "Interest"], ["message", "Message"]]) {
    const value = oneLine(lead[key]);
    if (value) lines.push(`${label}: ${value}`);
  }
  lines.push("", "Sent by the AI chat widget. The visitor pressed Send on the confirm card.");

  const email = { from, to: [to], subject, text: lines.join("\n") };
  const replyTo = oneLine(lead.email);
  if (replyTo) email.reply_to = replyTo;
  return email;
}

async function deliverLead(lead, business) {
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  const to = (process.env.LEAD_TO_EMAIL || "").trim();
  if (!apiKey || !plausibleEmail(to)) throw deliveryError("NOT_CONFIGURED", "Lead delivery is not configured.");

  let response;
  try {
    response = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildEmail(lead, business, to)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw deliveryError("TIMEOUT", "Lead delivery timed out.");
    }
    throw deliveryError("NETWORK", "Lead delivery failed: could not reach the email service.");
  }

  // Read and discard the answer so the connection is released; its contents are never used or logged.
  try {
    await response.text();
  } catch (err) {
    /* ignore */
  }
  if (!response.ok) throw deliveryError(`RESEND_${response.status}`, "The email service refused the request.");
}

module.exports = { deliverLead };
