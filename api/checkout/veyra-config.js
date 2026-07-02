/**
 * GET /api/checkout/veyra-config?session_id=<id>  (Vercel serverless, Node)
 *
 * Same-origin proxy for VeyraGate's card_capture_config endpoint. The
 * inline card form needs the BT public key + container path that VeyraGate
 * computed for this session; the browser can't read it cross-origin, so we
 * proxy it. No auth — card_capture_config is a session-scoped public config
 * endpoint (the session id is the capability).
 *
 * Returns VeyraGate's config verbatim. On 404/410 (session gone/expired) we
 * return 200 with { error: "session_unavailable", veyra } so the client can
 * render a friendly message without treating it as a hard proxy failure.
 *
 * SAUCE: read-only config. The only credential that ever reaches the browser
 * is the BT publishable key — never Stripe.js, never the VeyraGate Bearer key.
 */

const VEYRA_API_BASE = process.env.VEYRAGATE_API_BASE || "https://veyragate.com";

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const sessionId =
    req.query && typeof req.query.session_id === "string"
      ? req.query.session_id
      : Array.isArray(req.query && req.query.session_id)
        ? req.query.session_id[0]
        : "";
  if (!sessionId) {
    res.status(400).json({ error: "Missing session_id" });
    return;
  }

  const url = `${VEYRA_API_BASE}/api/checkout/${encodeURIComponent(
    sessionId,
  )}/card_capture_config`;

  let upstream;
  try {
    upstream = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("[ramp veyra-config] fetch failed", err && err.message);
    res.status(502).json({ error: "VeyraGate config request failed" });
    return;
  }

  const text = await upstream.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!upstream.ok && (upstream.status === 404 || upstream.status === 410)) {
    res.status(200).json({ error: "session_unavailable", veyra: data });
    return;
  }

  if (!upstream.ok) {
    console.error("[ramp veyra-config] VeyraGate returned", upstream.status);
    res.status(upstream.status).json({
      error: `VeyraGate returned ${upstream.status}`,
      veyra: data,
    });
    return;
  }

  res.status(200).json(data);
};
