// Server-side PIX generation via FreePay Brasil. Keys never touch the client.
// Front-end only ever sees { qrcode, amount, description, transactionId, gateEnabled, slug }.

const FREEPAY_URL = "https://api.freepaybrasil.com/v1/payment-transaction/create";

// Catalog mirrors the amounts/descriptions shown on each front-end screen
// (assets/index-BPEpE3Sa.js). Amounts here must match the price the customer
// sees before generating the PIX — a mismatch means the QR charges a
// different amount/product than what was displayed, which previously
// happened for the reused "eApQgzOk4p43Eb7" slug (fixed by splitting it into
// per-screen slugs below) and for a few screens off by a couple cents.
const CATALOG = {
  eApQgzOk4p43Eb7: { amount: 2987, description: "Seguro Prestamista Ágil" },
  Bq7VfTn82ZpXrKm4: { amount: 1990, description: "Confirmação de Pagamento Ágil" },
  mwK436e4RAygQ8b: { amount: 2681, description: "Taxa de Verificação Ágil" },
  BNjzgPA45aJ3M78: { amount: 1990, description: "Regularização TENF Ágil" },
  ODAK3LXnaVo3E6V: { amount: 2641, description: "Confirmação Titularidade Ágil" },
  DYp0Zx0LepVZmvX: { amount: 2344, description: "IOF Ágil" },
  nQ7kZ7D4JADG0eJ: { amount: 1700, description: "Cashback Ágil" },
  RmA83EQVDN13PVp: { amount: 3700, description: "PIX Final Ágil" },
  "2wq7Gr45Yp13BAN": { amount: 3408, description: "Fila Prioridade Ágil" },
  "6YQPgjW59PA3pxz": { amount: 4990, description: "Ativação Banco Ágil" },
  "5pjw3RmVMqNg2lQ": { amount: 2360, description: "Cartão Pré-aprovado Ágil" },
  "521rZJMODRQ3eaX": { amount: 1999, description: "Ativação Cartão Ágil" },
};

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
const hits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  hits.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

function isValidCpf(v) {
  return /^\d{11}$/.test(v || "");
}
function isValidPhone(v) {
  return /^\d{10,11}$/.test(v || "");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "method not allowed" });
    return;
  }

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  if (isRateLimited(ip)) {
    res.status(429).json({ success: false, error: "too many requests" });
    return;
  }

  const PUB = process.env.FREEPAY_PUBLIC_KEY;
  const SEC = process.env.FREEPAY_SECRET_KEY;
  if (!PUB || !SEC) {
    res.status(500).json({ success: false, error: "gateway not configured" });
    return;
  }

  const { slug, customer } = req.body || {};
  const product = CATALOG[slug];
  if (!product) {
    res.status(400).json({ success: false, error: "invalid product" });
    return;
  }

  const name = String(customer?.name || "").trim();
  const email = String(customer?.email || "").trim();
  const cpf = String(customer?.cpf || "").replace(/\D/g, "");
  const phone = String(customer?.phone || "").replace(/\D/g, "");

  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !isValidCpf(cpf) || !isValidPhone(phone)) {
    res.status(400).json({ success: false, error: "invalid customer data" });
    return;
  }

  const origin = `https://${req.headers.host}`;
  const auth = "Basic " + Buffer.from(`${PUB}:${SEC}`).toString("base64");

  try {
    const r = await fetch(FREEPAY_URL, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        amount: product.amount,
        payment_method: "pix",
        postback_url: `${origin}/api/freepay-webhook`,
        customer: {
          name, email,
          document: { type: "cpf", number: cpf },
          phone,
        },
        items: [{
          title: product.description,
          description: product.description,
          unit_price: product.amount,
          quantity: 1,
          tangible: false,
        }],
        metadata: { slug },
      }),
      signal: AbortSignal.timeout(25_000),
    });
    const data = await r.json();
    if (!r.ok || data?.success === false) {
      const msg = Array.isArray(data?.error_messages) && data.error_messages[0]?.message
        ? data.error_messages[0].message
        : (data.error || data.message || "gateway error");
      res.status(502).json({ success: false, error: msg });
      return;
    }
    const tx = data?.data || {};
    const qrcode = tx?.pix?.qr_code;
    const transactionId = tx?.id;
    if (!qrcode || !transactionId) {
      res.status(502).json({ success: false, error: "malformed gateway response" });
      return;
    }
    res.status(200).json({
      success: true,
      qrcode,
      amount: product.amount,
      description: product.description,
      transactionId: String(transactionId),
      expiresAt: null,
      gateEnabled: true,
      slug,
    });
  } catch (err) {
    res.status(502).json({ success: false, error: "upstream request failed" });
  }
}
