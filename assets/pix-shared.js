// Shared PIX tracking + polling logic used by checkout.html and index.html.
// Keeps the two integration points (standalone checkout page and the
// in-funnel modal) from drifting when the payment gateway changes.
window.PixShared = (function () {
  function fmtPrice(cents) {
    const reais = Math.floor(cents / 100);
    const c = String(cents % 100).padStart(2, '0');
    return 'R$ ' + reais.toLocaleString('pt-BR') + '<span class="cents">,' + c + '</span>';
  }

  const TTK_EVENT_MAP = { InitiateCheckout: 'InitiateCheckout', Purchase: 'CompletePayment' };

  // Fires Meta Pixel + TikTok Pixel (client) and /api/meta-capi (server),
  // all sharing the same event_id so Meta/TikTok dedupe client vs server.
  function trackEvent(event, { data, customer, slug }) {
    const value = (data.amount || 0) / 100;
    const contentName = data.description || 'Pagamento';
    const eventId = data.transactionId || undefined;

    if (typeof window.fbq === 'function') {
      try {
        window.fbq('track', event, { content_name: contentName, currency: 'BRL', value }, { eventID: eventId });
      } catch {}
    }

    const ttkEvent = TTK_EVENT_MAP[event];
    if (ttkEvent && typeof window.ttq === 'object' && typeof window.ttq.track === 'function') {
      try {
        window.ttq.track(ttkEvent, {
          content_id: slug || undefined,
          content_name: contentName,
          content_type: 'product',
          currency: 'BRL',
          value,
          quantity: 1,
        }, { event_id: eventId });
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
        }),
      }).catch(() => {});
    } catch {}
  }

  // Flevopay's expires_at is only trusted within a sane 1-15min window
  // (typical PIX expiry). Anything outside that (bad parse, wrong tz,
  // missing field) falls back to the caller's default timeout instead
  // of risking a bogus too-short/too-long poll window.
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
