// Server-side PIX status check via PinguPag. Keys never touch the client.

const PINGUPAG_QUERY_URL = "https://app.pingupag.com/api/v1/query";
const PAID_STATUSES = new Set(["approved"]);

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ success: false, error: "method not allowed" });
    return;
  }

  const API_KEY = process.env.PINGUPAG_SECRET_KEY;
  if (!API_KEY) {
    res.status(500).json({ success: false, error: "gateway not configured" });
    return;
  }

  const id = String(req.query?.id || "").trim();
  if (!id) {
    res.status(400).json({ success: false, error: "missing id" });
    return;
  }

  try {
    const r = await fetch(`${PINGUPAG_QUERY_URL}?action=get_transaction&id=${encodeURIComponent(id)}`, {
      headers: { "X-API-Key": API_KEY, Accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    const data = await r.json();
    if (!r.ok) {
      res.status(502).json({ success: false, error: data?.message || data?.error || "gateway error" });
      return;
    }
    const status = String(data?.status || "unknown").toLowerCase();
    res.status(200).json({ success: true, paid: PAID_STATUSES.has(status), status });
  } catch (err) {
    res.status(502).json({ success: false, error: "upstream request failed" });
  }
}
