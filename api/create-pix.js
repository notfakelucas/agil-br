// Server-side PIX generation via PinguPag. Keys never touch the client.
// Front-end only ever sees { qrcode, amount, description, transactionId, gateEnabled, slug }.

const PINGUPAG_URL = "https://app.pingupag.com/api/v1/transaction";

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

  const API_KEY = process.env.PINGUPAG_SECRET_KEY;
  if (!API_KEY) {
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
  // Referência única — PinguPag não gera uma pra gente, e ela mais tarde
  // permite achar a transação via /query?action=list_transactions.
  const reference = `${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const r = await fetch(PINGUPAG_URL, {
      method: "POST",
      headers: {
        "X-API-Key": API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: product.amount,
        description: product.description,
        reference,
        // Produtos não são cadastrados no painel da PinguPag (catálogo é
        // nosso, acima) — api_externa pula a validação de productHash.
        source: "api_externa",
        postback_url: `${origin}/api/pingupag-webhook`,
        customer: { name, email, document: cpf, phone },
      }),
      signal: AbortSignal.timeout(25_000),
    });
    const data = await r.json();
    if (!r.ok || data?.status !== "success") {
      res.status(502).json({ success: false, error: data?.message || data?.error || "gateway error" });
      return;
    }
    const qrcode = data?.qr_code;
    const transactionId = data?.transaction_id;
    if (!qrcode || transactionId == null) {
      res.status(502).json({ success: false, error: "malformed gateway response" });
      return;
    }
    res.status(200).json({
      success: true,
      qrcode,
      amount: product.amount,
      description: product.description,
      transactionId: String(transactionId),
      expiresAt: data?.expires_at || null,
      gateEnabled: true,
      slug,
    });
  } catch (err) {
    res.status(502).json({ success: false, error: "upstream request failed" });
  }
}
