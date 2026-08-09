// Server-side mirror of the client Meta Pixel events (Conversions API).
// Client passes the same event_id used in fbq(...) so Meta dedupes the two.
// Token/pixel id live in Vercel env vars — never in client code.

import { createHash } from "node:crypto";

const GRAPH_VERSION = "v21.0";
const ALLOWED_EVENTS = new Set(["PageView", "InitiateCheckout", "Purchase", "Lead"]);

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

function sha256(value) {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
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

  const token = process.env.META_CAPI_TOKEN;
  const pixelId = process.env.META_PIXEL_ID;
  if (!token || !pixelId) {
    res.status(500).json({ success: false, error: "capi not configured" });
    return;
  }

  const { event_name, event_id, event_source_url, value, currency, content_name, email, phone } = req.body || {};

  if (!ALLOWED_EVENTS.has(event_name)) {
    res.status(400).json({ success: false, error: "invalid event_name" });
    return;
  }

  const userData = {
    client_ip_address: ip !== "unknown" ? ip : undefined,
    client_user_agent: req.headers["user-agent"] || undefined,
  };
  if (email) userData.em = [sha256(email)];
  if (phone) userData.ph = [sha256(phone.replace(/\D/g, ""))];

  const payload = {
    data: [
      {
        event_name,
        event_time: Math.floor(Date.now() / 1000),
        event_id: event_id || undefined,
        event_source_url: event_source_url || undefined,
        action_source: "website",
        user_data: userData,
        custom_data:
          value != null
            ? { value, currency: currency || "BRL", content_name: content_name || undefined }
            : undefined,
      },
    ],
  };

  try {
    const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) {
      res.status(502).json({ success: false, error: data.error?.message || "meta api error" });
      return;
    }
    res.status(200).json({ success: true, events_received: data.events_received });
  } catch (err) {
    res.status(502).json({ success: false, error: "upstream request failed" });
  }
}
