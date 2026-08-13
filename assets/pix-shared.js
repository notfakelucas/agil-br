// Shared PIX tracking + polling logic used by checkout.html and index.html.
// Keeps the two integration points (standalone checkout page and the
// in-funnel modal) from drifting when the payment gateway changes.
window.PixShared = (function () {
  function fmtPrice(cents) {
    const reais = Math.floor(cents / 100);
    const c = String(cents % 100).padStart(2, '0');
    return 'R$ ' + reais.toLocaleString('pt-BR') + '<span class="cents">,' + c + '</span>';
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : undefined;
  }

  // Fires Meta Pixel (client, com Advanced Matching) + /api/meta-capi (server),
  // ambos com o mesmo event_id pra Meta dedupear client vs server.
  function trackEvent(event, { data, customer }) {
    const value = (data.amount || 0) / 100;
    const contentName = data.description || 'Pagamento';
    const eventId = data.transactionId || undefined;

    const nameParts = String(customer?.name || '').trim().split(/\s+/).filter(Boolean);
    const firstName = nameParts[0] || undefined;
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined;
    const cpfDigits = customer?.cpf ? String(customer.cpf).replace(/\D/g, '') : undefined;

    if (typeof window.fbq === 'function') {
      try {
        // Advanced Matching manual — pixel normaliza e hasheia (SHA-256)
        // antes de enviar, não precisa hashear aqui.
        window.fbq('set', 'userData', {
          em: customer?.email || undefined,
          ph: customer?.phone || undefined,
          fn: firstName,
          ln: lastName,
          external_id: cpfDigits,
        });
        window.fbq('track', event, { content_name: contentName, currency: 'BRL', value }, { eventID: eventId });
      } catch {}
    }

    try {
      fetch('/api/meta-capi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_name: event,
          event_id: eventId,
          event_source_url: window.location.href,
          value,
          currency: 'BRL',
          content_name: contentName,
          email: customer?.email,
          phone: customer?.phone,
          firstName,
          lastName,
          externalId: cpfDigits,
          fbc: getCookie('_fbc'),
          fbp: getCookie('_fbp'),
        }),
      }).catch(() => {});
    } catch {}
  }

  // expiresAt (PinguPag manda "YYYY-MM-DD HH:MM:SS") só é confiado dentro de
  // uma janela sã de 1-15min (expiração típica de PIX). Fora disso (parse
  // ruim, tz errada/ambígua, campo ausente) cai pro timeout padrão do
  // caller, em vez de arriscar uma janela de poll bizarramente curta ou longa.
  function computeTimeoutMs(expiresAt, fallbackMs) {
    if (!expiresAt) return fallbackMs;
    try {
      const t = new Date(String(expiresAt).replace(' ', 'T') + 'Z').getTime();
      const remaining = t - Date.now();
      if (!isFinite(remaining) || remaining < 60 * 1000 || remaining > 15 * 60 * 1000) return fallbackMs;
      return remaining;
    } catch {
      return fallbackMs;
    }
  }

  const REJECTED_STATUSES = new Set(['failed', 'refunded', 'chargeback']);

  // Polls /api/pix-status until paid, explicitly rejected, or timed out.
  // Returns { stop } so the caller can cancel it (e.g. on modal close).
  // Sem fallback por tempo: só chama onPaid quando o gateway confirma paid=true.
  function poll({ transactionId, expiresAt, intervalMs, timeoutMs, onPaid, onRejected, onExpired }) {
    let timer = null;
    const startMs = Date.now();
    const effectiveTimeout = computeTimeoutMs(expiresAt, timeoutMs);

    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
    }

    async function tick() {
      try {
        const r = await fetch('/api/pix-status?id=' + encodeURIComponent(transactionId));
        const s = await r.json();
        if (s.paid) { stop(); onPaid(); return; }
        if (s.status && REJECTED_STATUSES.has(String(s.status).toLowerCase())) {
          stop(); onRejected(s.status); return;
        }
      } catch { /* silent — próximo tick tenta de novo */ }

      const elapsed = Date.now() - startMs;
      if (elapsed > effectiveTimeout) {
        stop();
        onExpired();
      }
    }

    tick();
    timer = setInterval(tick, intervalMs);
    return { stop };
  }

  return { fmtPrice, trackEvent, poll };
})();
