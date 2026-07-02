/**
 * POST /api/checkout/veyra-pay  (Vercel serverless, Node)
 *
 * Same-origin proxy for VeyraGate's /pay-bt charge endpoint. After the
 * browser tokenizes the card through Basis Theory, the opaque BT token
 * intent id is submitted here for charging. Proxying avoids CORS on the
 * cross-origin call to veyragate.com and keeps veyragate.com invisible to
 * the customer.
 *
 * Forwards EVERYTHING except session_id, and only includes optional fields
 * when actually present. Notable vs the evobones reference:
 *   - three_ds_session_id IS forwarded here. The evobones card lane dropped
 *     it, which was a bug (server-side threshold-3DS re-pay lost the 3DS
 *     result). We forward it so a post-3DS re-charge carries the auth.
 *   - NEVER send wallet_type on this card lane. Tagging a card token as a
 *     wallet on a descriptor-masked tier is a SAUCE attribution leak and a
 *     hard server-side refusal (wallet_disallowed_by_policy).
 */

const VEYRA_API_BASE = process.env.VEYRAGATE_API_BASE || "https://veyragate.com";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const {
    session_id,
    basis_theory_token_intent_id,
    card_summary,
    three_ds_session_id,
    customer_name,
    customer_email,
    idempotency_key,
  } = body;

  if (!session_id) {
    res.status(400).json({ error: "Missing session_id" });
    return;
  }
  if (!basis_theory_token_intent_id) {
    res.status(400).json({ error: "Missing basis_theory_token_intent_id" });
    return;
  }

  const safeName =
    typeof customer_name === "string" && customer_name.trim()
      ? customer_name.trim()
      : null;
  const safeEmail =
    typeof customer_email === "string" && customer_email.trim()
      ? customer_email.trim()
      : null;

  const url = `${VEYRA_API_BASE}/api/checkout/${encodeURIComponent(
    session_id,
  )}/pay-bt`;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        basis_theory_token_intent_id,
        // CARD LANE: never wallet_type. Absence is the correct "plain card".
        ...(card_summary ? { card_summary } : {}),
        // Forward the 3DS session id when present so a post-3DS re-charge
        // carries the completed authentication (evobones omitted this).
        ...(three_ds_session_id ? { three_ds_session_id } : {}),
        ...(safeName ? { customer_name: safeName } : {}),
        ...(safeEmail ? { customer_email: safeEmail } : {}),
        ...(idempotency_key ? { idempotency_key } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    console.error("[ramp veyra-pay] fetch failed", err && err.message);
    res.status(502).json({ error: "VeyraGate pay request failed" });
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
    console.error("[ramp veyra-pay] VeyraGate returned", upstream.status);
    res.status(upstream.status).json({
      error: `VeyraGate returned ${upstream.status}`,
      veyra: data,
    });
    return;
  }

  res.status(200).json(data);
};
