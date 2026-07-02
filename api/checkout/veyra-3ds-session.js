/**
 * POST /api/checkout/veyra-3ds-session  (Vercel serverless, Node)
 *
 * Same-origin proxy for VeyraGate's 3DS-session endpoint. The inline card
 * form calls this when a token intent reports authentication ===
 * "sca_required"; it returns the device-fingerprint URL + optional
 * challenge URL that the form loads inside sandboxed iframes. Proxying
 * avoids CORS on the cross-origin call to veyragate.com.
 *
 * Session-scoped (no merchant key needed) — the session id is the auth.
 * Forwards everything except our routing field (session_id). Returns the
 * upstream response verbatim; a 503 is passed straight through so the client
 * can fall through to a direct pay without 3DS.
 */

const VEYRA_API_BASE = process.env.VEYRAGATE_API_BASE || "https://veyragate.com";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const sessionId = body.session_id;
  if (!sessionId) {
    res.status(400).json({ error: "Missing session_id" });
    return;
  }

  // Forward everything except the routing field.
  const forward = {};
  for (const k of Object.keys(body)) {
    if (k !== "session_id") forward[k] = body[k];
  }

  const url = `${VEYRA_API_BASE}/api/checkout/${encodeURIComponent(
    sessionId,
  )}/3ds/session`;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(forward),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.error("[ramp veyra-3ds-session] fetch failed", err && err.message);
    res.status(502).json({ error: "VeyraGate 3ds-session request failed" });
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
    console.error("[ramp veyra-3ds-session] VeyraGate returned", upstream.status);
    res.status(upstream.status).json({
      error: `VeyraGate returned ${upstream.status}`,
      veyra: data,
    });
    return;
  }

  res.status(200).json(data);
};
