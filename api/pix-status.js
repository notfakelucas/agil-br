// Server-side PIX status check via FreePay Brasil. Keys never touch the client.

const FREEPAY_INFO_URL = "https://api.freepaybrasil.com/v1/payment-transaction/info";
const PAID_STATUSES = new Set([
  "paid", "approved", "authorized", "succeeded", "completed",
  "success", "sucesso", "pago",
]);

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ success: false, error: "method not allowed" });
    return;
  }

  const PUB = process.env.FREEPAY_PUBLIC_KEY;
  const SEC = process.env.FREEPAY_SECRET_KEY;
  if (!PUB || !SEC) {
    res.status(500).json({ success: false, error: "gateway not configured" });
    return;
  }

  const id = String(req.query?.id || "").trim();
  if (!id) {
    res.status(400).json({ success: false, error: "missing id" });
    return;
  }

  const auth = "Basic " + Buffer.from(`${PUB}:${SEC}`).toString("base64");

  try {
    const r = await fetch(`${FREEPAY_INFO_URL}/${encodeURIComponent(id)}`, {
      headers: { Authorization: auth, Accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    const data = await r.json();
    if (!r.ok) {
      res.status(502).json({ success: false, error: data.error || data.message || "gateway error" });
      return;
    }
    // FreePay: { data: { status: "PAID"|"PENDING"|... }, success: bool }
    const status = String(data?.data?.status || data?.status || "unknown").toLowerCase();
    res.status(200).json({ success: true, paid: PAID_STATUSES.has(status), status });
  } catch (err) {
    res.status(502).json({ success: false, error: "upstream request failed" });
  }
}
