/**
 * POST /api/checkout/veyra-3ds-authenticate  (Vercel serverless, Node)
 *
 * Same-origin proxy for VeyraGate's 3DS-authenticate endpoint. The inline
 * card form calls this after the fingerprint (and optional challenge)
 * completes, to finalize the 3DS authentication before /pay-bt charges.
 * Proxying avoids CORS on the cross-origin call to veyragate.com.
 *
 * Session-scoped; the session id is the auth. Forwards everything except
 * session_id and returns the upstream response verbatim.
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

  const forward = {};
  for (const k of Object.keys(body)) {
    if (k !== "session_id") forward[k] = body[k];
  }

  const url = `${VEYRA_API_BASE}/api/checkout/${encodeURIComponent(
    sessionId,
  )}/3ds/authenticate`;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(forward),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.error(
      "[ramp veyra-3ds-authenticate] fetch failed",
      err && err.message,
    );
    res
      .status(502)
      .json({ error: "VeyraGate 3ds-authenticate request failed" });
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
    console.error(
      "[ramp veyra-3ds-authenticate] VeyraGate returned",
      upstream.status,
    );
    res.status(upstream.status).json({
      error: `VeyraGate returned ${upstream.status}`,
      veyra: data,
    });
    return;
  }

  res.status(200).json(data);
};
