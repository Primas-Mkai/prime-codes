// Lead validation: pure functions, no server, no network, no logging.
// validateLead() returns { ok: true, lead } or { ok: false, field, reason } (plain-English reasons).

const LIMITS = {
  name: { min: 2, max: 80 },
  company: { min: 0, max: 80 },
  message: { min: 0, max: 500 },
  email: { max: 120 },
  phone: { minDigits: 7, maxDigits: 15 },
};

const FIELDS = ["name", "email", "phone", "company", "interest", "message"];
const CARD_REASON = "looks like a card number and must not be shared";

// Control characters become a space (so words never glue together), then spaces are collapsed and trimmed.
function cleanText(value) {
  return String(value)
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

// A link: http(s), www., or domain-like text (a dot followed by 2 or more letters).
function hasLink(text) {
  return /https?:|www\./i.test(text) || /[\p{L}\p{N}-]\.\p{L}{2,}/u.test(text);
}

function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// True if the text has a run of 13 to 19 digits (spaces or dashes allowed between the digits) that passes Luhn.
// A "run" is a whole stretch of digits: a longer number is not treated as a card just because part of it passes.
function containsCardNumber(text) {
  const runs = String(text).match(/\d(?:[ -]?\d)*/g) || [];
  return runs.some((run) => {
    const digits = run.replace(/\D/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
  });
}

function isValidEmail(email) {
  return /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/.test(email);
}

// "+255 700-000.111" -> "+255700000111". Returns null unless it is 7 to 15 digits with an optional leading +.
function normalisePhone(text) {
  const stripped = text.replace(/[\s\-.()]/g, "");
  if (!/^\+?\d+$/.test(stripped)) return null;
  const digits = stripped.replace(/\D/g, "");
  if (digits.length < LIMITS.phone.minDigits || digits.length > LIMITS.phone.maxDigits) return null;
  return (stripped.startsWith("+") ? "+" : "") + digits;
}

function fail(field, reason) {
  return { ok: false, field, reason };
}

// input: the raw lead object. interests: the business's configured interests.
// options.visitorMessages: array of the texts the visitor typed; when given, any email or phone in the lead
// must appear in them (emails compared in lowercase, phones by digits only). Omit it to skip that check.
function validateLead(input, interests, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return fail("lead", "The details were missing or not in the right format.");
  }

  // 1. Every field is plain text: clean it, then reject markup, links and card numbers.
  const clean = {};
  for (const field of FIELDS) {
    const raw = input[field];
    if (raw === undefined || raw === null) {
      clean[field] = "";
      continue;
    }
    if (typeof raw !== "string") return fail(field, "must be plain text.");
    const text = cleanText(raw);
    if (/[<>]/.test(text)) return fail(field, "must not contain the characters < or >.");
    if (field !== "email" && hasLink(text)) return fail(field, "must not contain a link or web address.");
    if (field === "phone") {
      const digitCount = text.replace(/\D/g, "").length;
      // A phone number of 15 digits or fewer is exempt from the card check; longer ones are not.
      if (digitCount > LIMITS.phone.maxDigits && containsCardNumber(text)) return fail(field, CARD_REASON);
    } else if (containsCardNumber(text)) {
      return fail(field, CARD_REASON);
    }
    clean[field] = text;
  }

  // 2. Field rules.
  const lead = { name: clean.name, email: "", phone: "", company: clean.company, interest: "", message: clean.message };

  if (lead.name.length < LIMITS.name.min) return fail("name", "must be at least 2 characters.");
  if (lead.name.length > LIMITS.name.max) return fail("name", "must be 80 characters or fewer.");
  if (lead.company.length > LIMITS.company.max) return fail("company", "must be 80 characters or fewer.");
  if (lead.message.length > LIMITS.message.max) return fail("message", "must be 500 characters or fewer.");

  if (clean.email) {
    if (clean.email.length > LIMITS.email.max) return fail("email", "must be 120 characters or fewer.");
    if (!isValidEmail(clean.email)) return fail("email", "is not a valid email address.");
    lead.email = clean.email.toLowerCase();
  }
  if (clean.phone) {
    const phone = normalisePhone(clean.phone);
    if (!phone) return fail("phone", "must be 7 to 15 digits, with an optional leading + (no letters).");
    lead.phone = phone;
  }
  if (!lead.email && !lead.phone) return fail("email", "needs at least one way to contact the visitor: an email address or a phone number.");

  const allowed = Array.isArray(interests) ? interests : [];
  const match = allowed.find((i) => i.toLowerCase() === clean.interest.toLowerCase());
  if (!clean.interest || !match) return fail("interest", "must be one of: " + allowed.join(", ") + ".");
  lead.interest = match;

  // 3. The contact details must really have been typed by the visitor.
  if (Array.isArray(options.visitorMessages)) {
    const texts = options.visitorMessages.filter((t) => typeof t === "string");
    if (lead.email && !texts.some((t) => t.toLowerCase().includes(lead.email))) {
      return fail("email", "was not provided by the visitor in this conversation.");
    }
    if (lead.phone) {
      const wanted = lead.phone.replace(/\D/g, "");
      if (!texts.some((t) => t.replace(/\D/g, "").includes(wanted))) {
        return fail("phone", "was not provided by the visitor in this conversation.");
      }
    }
  }

  return { ok: true, lead };
}

module.exports = { validateLead, containsCardNumber, luhnValid, hasLink, cleanText, normalisePhone, isValidEmail, LIMITS };
