// Receives FreePay Brasil's payment status postbacks (configured via
// postback_url in api/create-pix.js). Must ack 200 quickly per their docs.
//
// Note: this project has no persistent store (KV/Redis) wired up, so this
// endpoint currently just logs the event for visibility/audit — it does not
// speed up the client-side polling in checkout.html/index.html, which reads
// status live from FreePay's own query endpoint via /api/pix-status on
// every tick. Wiring a store here would let /api/pix-status check it first
// and skip the round-trip to FreePay.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "method not allowed" });
    return;
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  // Aceita {data:{id,status}}, {transaction:{...}}, ou top-level {id,status}
  // FreePay real posta com PascalCase (Id, Status) — aceita ambos.
  const tx = body.data || body.transaction || body.event?.data || body;
  const id = String(tx.id || tx.Id || tx.idtransaction || tx.transactionId || body.id || body.Id || "").trim();
  const status = String(tx.status || tx.Status || body.status || body.Status || "").trim();

  console.log("[freepay-webhook]", JSON.stringify({ id, status }));

  res.status(200).json({ success: true });
}
