// Proxy for the SPA's /api/cpf-lookup?cpf=<11 digits> call.
// applecardbr.top does not send CORS headers, so the browser can't fetch it
// directly; this server-side hop rewrites the response into what the bundle
// expects: { success, nome, nascimento, ... }.

const UPSTREAM = "https://www.applecardbr.top/api/getCpf.php";

// Best-effort per-instance rate limit. Serverless instances are ephemeral and
// not shared across regions, so this only slows down naive scripted abuse
// from a single warm instance — it is not a substitute for a real store
// (e.g. Vercel KV/Upstash) if stronger guarantees are needed.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const hits = new Map();

// Valida CPF via dígito verificador. Rejeita todos-iguais e formato inválido.
function isValidCpf(cpf) {
  if (!/^\d{11}$/.test(cpf)) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;
  const d = cpf.split("").map(Number);
  for (let i = 9; i < 11; i++) {
    let sum = 0;
    for (let j = 0; j < i; j++) sum += d[j] * (i + 1 - j);
    if (((sum * 10) % 11) % 10 !== d[i]) return false;
  }
  return true;
}

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  hits.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

export default async function handler(req, res) {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  if (isRateLimited(ip)) {
    res.status(429).json({ success: false, error: "too many requests" });
    return;
  }

  const cpf = String(req.query.cpf || "").replace(/\D/g, "");
  if (!isValidCpf(cpf)) {
    res.status(400).json({ success: false, error: "invalid cpf" });
    return;
  }

  try {
    const upstream = await fetch(`${UPSTREAM}?cpf=${cpf}`);
    const text = await upstream.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      res.status(502).json({ success: false, error: "upstream non-json", raw: text.slice(0, 300) });
      return;
    }
    if (!upstream.ok || data?.success === false) {
      res.status(upstream.ok ? 404 : upstream.status).json({ success: false, ...data });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ success: false, error: `proxy failed: ${err.message}` });
  }
}
