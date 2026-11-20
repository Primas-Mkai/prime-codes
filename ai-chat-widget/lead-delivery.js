// Lead delivery. Not implemented yet: a later step will send leads by email.
// Until then every call fails with code NOT_CONFIGURED, so /api/lead answers 501 and nothing is stored or sent.
async function deliverLead(lead, business) {
  const err = new Error("Lead delivery is not configured.");
  err.code = "NOT_CONFIGURED";
  throw err;
}

module.exports = { deliverLead };
