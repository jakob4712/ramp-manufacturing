/**
 * POST /api/checkout/session  (Vercel serverless function, Node, zero-config)
 *
 * Creates a VeyraGate checkout session for the Ramp Manufacturing inline
 * card lane. The browser NEVER talks to veyragate.com and NEVER sees the
 * Bearer key — this same-origin function is the only thing holding it.
 *
 * Ported from evobones's veyra-session route, adapted to:
 *   - vanilla Node serverless (module.exports handler, no Next.js)
 *   - channel = ramp_mfg_masked (NOT evobones_masked)
 *   - full-cart total flow (no Apple Pay, no shipping picker) — the amount
 *     is whatever the browser computed from the cart; there is no wallet
 *     sheet adding shipping on top.
 *
 * SAUCE: the VEYRAGATE_API_KEY Bearer credential is server-only. No card
 * data ever reaches this function; the browser tokenizes through Basis
 * Theory and only opaque ids/metadata flow through the later proxies.
 */

const VEYRA_API_BASE = process.env.VEYRAGATE_API_BASE || "https://veyragate.com";
const VEYRA_CHANNEL = "ramp_mfg_masked";

function originFromRequest(req) {
  // Prefer the forwarded origin/host that Vercel populates at the edge.
  const proto =
    (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  if (host) return `${proto}://${host}`;
  const origin = req.headers.origin;
  if (origin) return String(origin);
  return "https://rampmanufacturing.co";
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const apiKey = process.env.VEYRAGATE_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "veyragate_api_key_not_configured" });
    return;
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const {
    amount_cents,
    currency,
    customer_email,
    cart_lines,
    cust_name,
    cust_phone,
    ship_line1,
    ship_city,
    ship_state,
    ship_zip,
  } = body;

  const cents = Number(amount_cents);
  if (!Number.isFinite(cents) || cents <= 0) {
    res.status(400).json({ error: "invalid_amount" });
    return;
  }

  const safeEmail =
    typeof customer_email === "string" && customer_email.trim()
      ? customer_email.trim()
      : undefined;

  let upstream;
  try {
    upstream = await fetch(`${VEYRA_API_BASE}/api/v1/checkout_sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount_cents: cents,
        currency: "usd",
        ...(safeEmail ? { customer_email: safeEmail } : {}),
        channel: VEYRA_CHANNEL,
        allowed_origin: originFromRequest(req),
        metadata: {
          src_brand: "ramp_manufacturing",
          src_route: "ramp_mfg_checkout",
          cart_lines,
          cust_name,
          cust_phone,
          ship_line1,
          ship_city,
          ship_state,
          ship_zip,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("[ramp session] fetch failed", err && err.message);
    res.status(502).json({ error: "veyra_unreachable" });
    return;
  }

  const text = await upstream.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!upstream.ok) {
    console.error("[ramp session] VeyraGate non-2xx", upstream.status);
    res.status(upstream.status).json({
      error: `veyra_${upstream.status}`,
      veyra: data,
    });
    return;
  }

  const sessionId = data && (data.public_id != null ? data.public_id : data.id);
  if (!sessionId) {
    res.status(502).json({ error: "veyra_no_session_id" });
    return;
  }

  res.status(200).json({ session_id: sessionId });
};
