// Receives PinguPag's payment status postbacks (configured via
// postback_url in api/create-pix.js). Must ack 200 quickly per their docs.
//
// Note: this project has no persistent store (KV/Redis) wired up, so this
// endpoint currently just logs the event for visibility/audit — it does not
// speed up the client-side polling in checkout.html/index.html, which reads
// status live from PinguPag's own query endpoint via /api/pix-status on
// every tick. Wiring a store here would let /api/pix-status check it first
// and skip the round-trip to PinguPag.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "method not allowed" });
    return;
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const id = String(body.transaction_id || body.id || "").trim();
  const status = String(body.status || "").trim();

  console.log("[pingupag-webhook]", JSON.stringify({ id, status }));

  res.status(200).json({ success: true });
}
