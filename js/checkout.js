/* Ramp Manufacturing Co. — inline card checkout (Basis Theory).
 *
 * Vanilla-JS port of evobones's inline-card-form.tsx. This is the CARD-ONLY
 * surface: a single combined Basis Theory CardElement (one iframe carrying
 * card number + MM/YY + CVC inline) plus the full 3DS state machine.
 *
 * SAUCE (non-negotiable):
 *   - No Stripe.js, ever. BT (js.basistheory.com) is the only external
 *     checkout script. Every VeyraGate call goes through same-origin
 *     /api/checkout/* functions — the browser never sees veyragate.com or
 *     any Bearer key.
 *   - ONE combined card element. Never three separate iframes.
 *   - Card lane sends NO wallet_type.
 *   - Customer-safe messages only; never raw API bodies.
 *
 * Load-time mount: on page load we (1) read the cart, (2) create the
 * VeyraGate session, (3) fetch the card-capture config, (4) init BT and
 * mount the combined card element — so the card fields are visible
 * immediately. The Pay button then just tokenizes + pays.
 */
(function () {
  "use strict";

  var CART_KEY = "ramp_cart_v1";
  var FINGERPRINT_TIMEOUT_MS = 12000;
  var CHALLENGE_TIMEOUT_MS = 5 * 60000;
  var GENERIC_ERROR =
    "We couldn't complete your card. Please check your details or try another card.";

  // ── DOM handles ──────────────────────────────────────────────────────
  var els = {
    empty: document.querySelector("[data-co-empty]"),
    body: document.querySelector("[data-co-body]"),
    lines: document.querySelector("[data-co-lines]"),
    total: document.querySelector("[data-co-total]"),
    // Phase 1 (contact) + Phase 2 (payment) forms.
    contactForm: document.querySelector("[data-co-contact-form]"),
    payForm: document.querySelector("[data-co-pay-form]"),
    continue: document.querySelector("[data-co-continue]"),
    errorContact: document.querySelector("[data-co-error-contact]"),
    summary: document.querySelector("[data-co-summary-body]"),
    edit: document.querySelector("[data-co-edit]"),
    card: document.querySelector("[data-co-card]"),
    cardLoading: document.querySelector("[data-co-card-loading]"),
    status: document.querySelector("[data-co-status]"),
    error: document.querySelector("[data-co-error]"),
    threeds: document.querySelector("[data-co-3ds]"),
    pay: document.querySelector("[data-co-pay]"),
    name: document.getElementById("co-name"),
    email: document.getElementById("co-email"),
    phone: document.getElementById("co-phone"),
    line1: document.getElementById("co-line1"),
    city: document.getElementById("co-city"),
    state: document.getElementById("co-state"),
    zip: document.getElementById("co-zip")
  };
  if (!els.contactForm || !els.payForm || !els.card || !els.pay) return;

  // ── Cart ─────────────────────────────────────────────────────────────
  function loadCart() {
    try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch (e) { return []; }
  }
  function cartTotalDollars(cart) {
    return cart.reduce(function (s, i) { return s + (Number(i.price) || 0) * (Number(i.qty) || 0); }, 0);
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c];
    });
  }
  function money(dollars) { return "$" + (Number(dollars) || 0).toFixed(2); }

  var cart = loadCart();
  if (!cart.length) {
    // Empty cart — flash the guard then bounce to the catalog.
    if (els.empty) els.empty.hidden = false;
    if (els.body) els.body.hidden = true;
    window.location.replace("materials.html");
    return;
  }
  if (els.empty) els.empty.hidden = true;
  if (els.body) els.body.hidden = false;

  var amountCents = Math.round(cartTotalDollars(cart) * 100);

  function renderSummary() {
    if (els.lines) {
      els.lines.innerHTML = cart.map(function (i) {
        var lineTotal = (Number(i.price) || 0) * (Number(i.qty) || 0);
        return '<li class="co-line">' +
          '<img src="' + esc(i.img) + '" alt="" />' +
          '<div>' +
            '<div class="l-name">' + esc(i.name) + '</div>' +
            (i.spec ? '<div class="l-spec">' + esc(i.spec) + '</div>' : '') +
            '<div class="l-qty">Qty ' + (Number(i.qty) || 0) + ' &middot; ' + money(i.price) + ' ea</div>' +
          '</div>' +
          '<div class="l-price">' + money(lineTotal) + '</div>' +
        '</li>';
      }).join("");
    }
    if (els.total) els.total.textContent = money(amountCents / 100);
  }
  renderSummary();

  var cartLinesSummary = cart.map(function (i) {
    return (Number(i.qty) || 0) + "x " + i.name + (i.spec ? " (" + i.spec + ")" : "");
  }).join("; ").slice(0, 500);

  // ── UI helpers ───────────────────────────────────────────────────────
  function setPayLabel() { els.pay.textContent = "Pay " + money(amountCents / 100); }
  setPayLabel();

  function showError(msg) {
    if (!els.error) return;
    els.error.textContent = msg || GENERIC_ERROR;
    els.error.classList.add("show");
  }
  function clearError() { if (els.error) { els.error.textContent = ""; els.error.classList.remove("show"); } }
  function showContactError(msg) {
    if (!els.errorContact) return;
    els.errorContact.textContent = msg || GENERIC_ERROR;
    els.errorContact.classList.add("show");
  }
  function clearContactError() { if (els.errorContact) { els.errorContact.textContent = ""; els.errorContact.classList.remove("show"); } }
  function showStatus(msg) {
    if (!els.status) return;
    if (msg) { els.status.textContent = msg; els.status.classList.add("show"); }
    else { els.status.textContent = ""; els.status.classList.remove("show"); }
  }
  function setBusy(busy, label) {
    els.pay.disabled = busy || !cardComplete || !btReady;
    if (busy) { els.pay.textContent = label || "Processing…"; }
    else { setPayLabel(); }
  }

  // ── Contact validation ───────────────────────────────────────────────
  function contactValues() {
    return {
      name: (els.name && els.name.value || "").trim(),
      email: (els.email && els.email.value || "").trim(),
      phone: (els.phone && els.phone.value || "").trim(),
      line1: (els.line1 && els.line1.value || "").trim(),
      city: (els.city && els.city.value || "").trim(),
      state: (els.state && els.state.value || "").trim(),
      zip: (els.zip && els.zip.value || "").trim()
    };
  }
  function validateContact() {
    var v = contactValues();
    if (!v.name) return "Please enter your full name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) return "Please enter a valid email address.";
    if (!v.phone) return "Please enter a phone number.";
    if (!v.line1) return "Please enter your billing address.";
    if (!v.city) return "Please enter your city.";
    if (!v.state) return "Please enter your state.";
    if (!v.zip) return "Please enter your ZIP code.";
    return null;
  }

  // ── 3DS pure state machine (ported from three-ds-state.ts) ───────────
  function initialCtx() {
    return {
      state: "idle",
      tokenIntentId: null,
      authentication: null,
      threeDsSessionId: null,
      deviceFingerprintUrl: null,
      challengeUrl: null,
      message: null
    };
  }
  var SAFE_MESSAGES = {
    tokenize_failed: GENERIC_ERROR,
    three_ds_unavailable: "Additional authentication is temporarily unavailable. Please try another card or contact support.",
    three_ds_session_failed: "Card authentication is temporarily unavailable. Please try again.",
    three_ds_fingerprint_timeout: "Card authentication timed out. Please try again.",
    three_ds_challenge_failed: "Card authentication did not complete. Please try again or use another card.",
    three_ds_authenticate_failed: "Card authentication did not complete. Please try again or use another card.",
    pay_failed: GENERIC_ERROR,
    internal: GENERIC_ERROR
  };
  function fail(reason, override) {
    return { state: "failed", message: override || SAFE_MESSAGES[reason] || GENERIC_ERROR };
  }
  function advance(ctx, ev) {
    switch (ev.type) {
      case "reset": return initialCtx();
      case "tokenize.start":
        return Object.assign({}, ctx, { state: "tokenizing", message: null });
      case "tokenize.success": {
        var requires3ds = ev.authentication === "sca_required";
        return Object.assign({}, ctx, {
          state: requires3ds ? "three_ds_required" : "ready_to_pay",
          tokenIntentId: ev.tokenIntentId,
          authentication: ev.authentication
        });
      }
      case "tokenize.failed": return Object.assign({}, ctx, fail("tokenize_failed"));
      case "three_ds.session.start":
        if (ctx.state !== "three_ds_required") return ctx;
        return Object.assign({}, ctx, { state: "three_ds_session_creating" });
      case "three_ds.session.success": {
        if (ctx.state !== "three_ds_session_creating") return ctx;
        var next = ev.deviceFingerprintUrl
          ? "three_ds_fingerprinting"
          : ev.challengeUrl ? "three_ds_challenge_required" : "three_ds_authenticating";
        return Object.assign({}, ctx, {
          state: next,
          threeDsSessionId: ev.threeDsSessionId,
          deviceFingerprintUrl: ev.deviceFingerprintUrl,
          challengeUrl: ev.challengeUrl
        });
      }
      case "three_ds.session.unavailable": return Object.assign({}, ctx, fail("three_ds_unavailable"));
      case "three_ds.session.skipped":
        if (ctx.state !== "three_ds_session_creating" && ctx.state !== "three_ds_required") return ctx;
        return Object.assign({}, ctx, {
          state: "ready_to_pay", threeDsSessionId: null, deviceFingerprintUrl: null, challengeUrl: null
        });
      case "three_ds.session.failed": return Object.assign({}, ctx, fail("three_ds_session_failed"));
      case "three_ds.fingerprint.done":
        if (ctx.state !== "three_ds_fingerprinting") return ctx;
        return Object.assign({}, ctx, {
          state: ctx.challengeUrl ? "three_ds_challenge_required" : "three_ds_authenticating"
        });
      case "three_ds.fingerprint.timeout": return Object.assign({}, ctx, fail("three_ds_fingerprint_timeout"));
      case "three_ds.challenge.done":
        if (ctx.state !== "three_ds_challenge_required" && ctx.state !== "three_ds_challenging") return ctx;
        return Object.assign({}, ctx, { state: "three_ds_authenticating" });
      case "three_ds.challenge.cancelled":
      case "three_ds.challenge.failed": return Object.assign({}, ctx, fail("three_ds_challenge_failed"));
      case "three_ds.authenticate.success":
        if (ctx.state !== "three_ds_authenticating") return ctx;
        return Object.assign({}, ctx, { state: "ready_to_pay" });
      case "three_ds.authenticate.failed": return Object.assign({}, ctx, fail("three_ds_authenticate_failed"));
      case "pay.start":
        if (ctx.state !== "ready_to_pay") return ctx;
        return Object.assign({}, ctx, { state: "paying" });
      case "pay.success": return Object.assign({}, ctx, { state: "succeeded", message: null });
      case "pay.failed": return Object.assign({}, ctx, { state: "failed", message: ev.message });
      default: return ctx;
    }
  }
  function statusCopy(ctx) {
    switch (ctx.state) {
      case "three_ds_required": return "Your bank requires additional verification.";
      case "three_ds_session_creating":
      case "three_ds_fingerprinting": return "Preparing additional verification…";
      case "three_ds_challenge_required": return "Your bank requires additional verification.";
      case "three_ds_challenging": return "Complete the prompt to continue.";
      case "three_ds_authenticating": return "Verifying with your bank…";
      case "paying": return "Processing payment…";
      default: return null;
    }
  }
  function isBusy(ctx) {
    return ctx.state === "tokenizing" || ctx.state === "three_ds_session_creating" ||
      ctx.state === "three_ds_fingerprinting" || ctx.state === "three_ds_challenging" ||
      ctx.state === "three_ds_authenticating" || ctx.state === "paying";
  }

  // Auth-status normalizer (ported from iframe-3ds-handlers.ts).
  function normalizeAuthStatus(s) {
    if (typeof s !== "string") return "failed";
    var lower = s.trim().toLowerCase();
    if (lower === "successful" || lower === "success" || lower === "y" || lower === "a") return "successful";
    if (lower === "challenge_required" || lower === "challenge-required" || lower === "c" || lower === "challenge") return "challenge_required";
    return "failed";
  }

  // ── State container + render ─────────────────────────────────────────
  var ctx = initialCtx();
  var paymentInputs = null; // { tokenIntentId, cardSummary, threeDsSessionId }
  var fingerprintTimer = null;
  var challengeTimer = null;

  function dispatch(ev) {
    ctx = advance(ctx, ev);
    onStateChange();
  }

  function clearTimers() {
    if (fingerprintTimer) { clearTimeout(fingerprintTimer); fingerprintTimer = null; }
    if (challengeTimer) { clearTimeout(challengeTimer); challengeTimer = null; }
  }

  function render3ds() {
    if (!els.threeds) return;
    // Fingerprint: 1x1 sandboxed iframe, kept in the rendered tree (not
    // display:none) so its load event fires, but visually collapsed.
    if (ctx.state === "three_ds_fingerprinting" && ctx.deviceFingerprintUrl) {
      els.threeds.hidden = false;
      els.threeds.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;padding:0;border:0;margin:0;background:transparent;clip:rect(0 0 0 0);";
      els.threeds.innerHTML = "";
      var fp = document.createElement("iframe");
      fp.title = "card-authentication-fingerprint";
      fp.setAttribute("sandbox", "allow-scripts");
      fp.style.cssText = "width:1px;height:1px;opacity:0;border:0;";
      fp.addEventListener("load", function () { dispatch({ type: "three_ds.fingerprint.done" }); });
      fp.src = ctx.deviceFingerprintUrl;
      els.threeds.appendChild(fp);
      return;
    }
    // Challenge: visible sandboxed iframe with a manual-complete button.
    if ((ctx.state === "three_ds_challenge_required" || ctx.state === "three_ds_challenging") && ctx.challengeUrl) {
      els.threeds.hidden = false;
      els.threeds.style.cssText = "";
      els.threeds.innerHTML =
        '<iframe title="card-authentication-challenge" sandbox="allow-scripts allow-forms allow-top-navigation-by-user-activation"></iframe>' +
        '<div class="co-3ds-actions"><span>Your bank requires additional verification.</span>' +
        '<span><button type="button" class="btn btn--light" data-3ds-done>I’ve completed verification</button></span></div>';
      els.threeds.querySelector("iframe").src = ctx.challengeUrl;
      var doneBtn = els.threeds.querySelector("[data-3ds-done]");
      if (doneBtn) doneBtn.addEventListener("click", function () { dispatch({ type: "three_ds.challenge.done" }); });
      return;
    }
    // Otherwise: teardown.
    els.threeds.hidden = true;
    els.threeds.style.cssText = "";
    els.threeds.innerHTML = "";
  }

  function onStateChange() {
    // Status banner.
    if (ctx.state === "failed") {
      showStatus(null);
      showError(ctx.message || GENERIC_ERROR);
    } else {
      var sc = statusCopy(ctx);
      showStatus(sc);
      if (sc) clearError();
    }

    render3ds();

    // Pay button state.
    var busy = isBusy(ctx) || ctx.state === "succeeded";
    if (ctx.state === "succeeded") {
      els.pay.disabled = true; els.pay.textContent = "Payment complete";
    } else if (busy) {
      setBusy(true, statusCopy(ctx) || "Processing…");
    } else {
      setBusy(false);
    }

    // Timers.
    clearTimers();
    if (ctx.state === "three_ds_fingerprinting") {
      fingerprintTimer = setTimeout(function () { dispatch({ type: "three_ds.fingerprint.done" }); }, FINGERPRINT_TIMEOUT_MS);
    }
    if (ctx.state === "three_ds_challenge_required" || ctx.state === "three_ds_challenging") {
      challengeTimer = setTimeout(function () { dispatch({ type: "three_ds.challenge.failed" }); }, CHALLENGE_TIMEOUT_MS);
    }

    // Side-effect transitions. Both callees are guarded against re-entry
    // (runAuthenticate via `authenticating`, callPayBt via `paying-in-flight`)
    // so a re-render in the same state can never double-charge / double-auth.
    if (ctx.state === "three_ds_authenticating") runAuthenticate();
    if (ctx.state === "ready_to_pay" && paymentInputs && !payInFlight) {
      callPayBt(paymentInputs.tokenIntentId, paymentInputs.cardSummary, paymentInputs.threeDsSessionId);
    }
  }

  // ── BT init + card element mount ─────────────────────────────────────
  var bt = null;
  var cardEl = null;
  var btReady = false;
  var cardComplete = false;
  var sessionId = null;
  var containerPath = null;

  function apiJson(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.text().then(function (t) {
        var body = {};
        try { body = t ? JSON.parse(t) : {}; } catch (e) { body = { raw: t }; }
        return { ok: r.ok, status: r.status, body: body };
      });
    });
  }

  function createSession() {
    var v = contactValues();
    return apiJson("/api/checkout/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount_cents: amountCents,
        currency: "usd",
        customer_email: v.email || undefined,
        cart_lines: cartLinesSummary,
        cust_name: v.name || undefined,
        cust_phone: v.phone || undefined,
        ship_line1: v.line1 || undefined,
        ship_city: v.city || undefined,
        ship_state: v.state || undefined,
        ship_zip: v.zip || undefined
      })
    }).then(function (res) {
      if (!res.ok || !res.body || !res.body.session_id) {
        throw new Error("session_" + (res.status || "err"));
      }
      return res.body.session_id;
    });
  }

  function fetchConfig(sid) {
    return apiJson("/api/checkout/veyra-config?session_id=" + encodeURIComponent(sid), {
      headers: { Accept: "application/json" }
    }).then(function (res) {
      if (!res.ok || !res.body || res.body.error === "session_unavailable") {
        throw new Error("config_unavailable");
      }
      return res.body;
    });
  }

  function mountCard(config) {
    var btCfg = config.basis_theory || {};
    var publicKey = btCfg.public_api_key;
    containerPath = btCfg.container_path || null;
    // Honor config-level capture engine: BT-only surface.
    if (config.capture_engine && config.capture_engine !== "basis_theory_elements") {
      throw new Error("engine_unsupported");
    }
    if (!publicKey) throw new Error("no_public_key");
    if (typeof BasisTheory === "undefined") throw new Error("bt_sdk_missing");

    // Guard against a stale element from a prior Continue (user edited
    // details and continued again). Tear the old one down before re-mount.
    teardownCard();

    return BasisTheory.init(publicKey, { elements: true }).then(function (instance) {
      bt = instance;
      cardEl = bt.createElement("card", {
        targetId: "bt-card-element",
        style: {
          base: {
            color: "#14181d",
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: "16px",
            "::placeholder": { color: "#7b8691" }
          }
        },
        placeholder: {
          cardNumber: "1234 1234 1234 1234",
          cardExpirationDate: "MM / YY",
          cardSecurityCode: "CVC"
        },
        inputMode: "numeric",
        validateOnChange: true
      });

      cardEl.on("change", function (event) {
        var e = event || {};
        cardComplete = e.complete === true;
        clearError();
        // Re-evaluate pay button availability.
        if (!isBusy(ctx) && ctx.state !== "succeeded") setBusy(false);
      });
      cardEl.on("focus", function () {
        if (els.card) els.card.classList.add("co-focused");
      });
      cardEl.on("blur", function () {
        if (els.card) els.card.classList.remove("co-focused");
      });

      // Clear the loading placeholder before mount so BT owns the node.
      if (els.cardLoading && els.cardLoading.parentNode) {
        els.cardLoading.parentNode.removeChild(els.cardLoading);
      }
      return cardEl.mount("#bt-card-element");
    }).then(function () {
      btReady = true;
      setBusy(false);
      scrubBtTitle();
    });
  }

  // Scrub BT iframe title so it doesn't leak the gateway name; keep it
  // processor-agnostic. BT exposes no title prop on the combined element.
  function scrubBtTitle() {
    try {
      var apply = function () {
        var frames = document.querySelectorAll('iframe[src*="basistheory"]');
        frames.forEach(function (f) {
          if (f.getAttribute("title") !== "Card details") f.setAttribute("title", "Card details");
        });
      };
      apply();
      var mo = new MutationObserver(apply);
      mo.observe(document.body, { childList: true, subtree: true, attributeFilter: ["title", "src"] });
    } catch (e) { /* non-fatal */ }
  }

  // Tear down any mounted BT card element so a re-Continue can mount fresh
  // without a double-mount conflict. Safe to call when nothing is mounted.
  function teardownCard() {
    if (cardEl) {
      try { cardEl.unmount(); } catch (e) { /* already unmounted */ }
    }
    cardEl = null;
    btReady = false;
    cardComplete = false;
    // Restore the loading placeholder inside the mount node for next time.
    if (els.card) {
      els.card.classList.remove("co-focused");
      els.card.innerHTML = '<span class="co-loading" data-co-card-loading>Loading secure card field…</span>';
      els.cardLoading = els.card.querySelector("[data-co-card-loading]");
    }
  }

  // ── Two-phase flow ───────────────────────────────────────────────────
  // Phase switch: reveal contact (Phase 1) or payment (Phase 2).
  function showPhase(phase) {
    if (phase === "payment") {
      if (els.contactForm) els.contactForm.hidden = true;
      if (els.payForm) els.payForm.hidden = false;
    } else {
      if (els.payForm) els.payForm.hidden = true;
      if (els.contactForm) els.contactForm.hidden = false;
    }
  }

  // Compact one-line-ish summary of entered details shown above the card.
  function renderDetailSummary() {
    if (!els.summary) return;
    var v = contactValues();
    var addr = [v.line1, v.city, v.state, v.zip].filter(Boolean).join(", ");
    els.summary.innerHTML =
      "<strong>" + esc(v.name) + "</strong>" +
      esc(v.email) + (v.phone ? " &middot; " + esc(v.phone) : "") + "<br>" +
      esc(addr);
  }

  // Continue (Phase 1 submit): validate, then create a FRESH session with the
  // now-filled contact/shipping metadata, fetch config, mount the card, and
  // reveal Phase 2. On failure, stay on Phase 1 with a friendly error.
  var continuing = false;
  function handleContinue() {
    if (continuing) return;
    clearContactError();

    var contactErr = validateContact();
    if (contactErr) { showContactError(contactErr); return; }

    continuing = true;
    sessionId = null; // never reuse a stale session across edits
    var prevLabel = els.continue ? els.continue.textContent : "";
    if (els.continue) { els.continue.disabled = true; els.continue.textContent = "Preparing secure checkout…"; }

    createSession()
      .then(function (sid) { sessionId = sid; return fetchConfig(sid); })
      .then(function (config) { return mountCard(config); })
      .then(function () {
        continuing = false;
        if (els.continue) { els.continue.disabled = false; els.continue.textContent = prevLabel; }
        renderDetailSummary();
        showPhase("payment");
        // Bring the card panel into view.
        if (els.payForm && typeof els.payForm.scrollIntoView === "function") {
          els.payForm.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      })
      .catch(function (err) {
        continuing = false;
        console.warn("[ramp checkout] continue failed", err && err.message);
        sessionId = null;
        if (els.continue) { els.continue.disabled = false; els.continue.textContent = prevLabel; }
        showContactError("Checkout is temporarily unavailable. Please try again in a moment.");
      });
  }

  // Edit (Phase 2 → Phase 1): return to contact. Tear down the card element
  // and clear the stale session so re-Continue mints a fresh one.
  function handleEdit() {
    teardownCard();
    sessionId = null;
    ctx = initialCtx();
    payInFlight = false;
    authenticating = false;
    paymentInputs = null;
    clearTimers();
    showStatus(null);
    clearError();
    if (els.threeds) { els.threeds.hidden = true; els.threeds.style.cssText = ""; els.threeds.innerHTML = ""; }
    showPhase("contact");
    if (els.contactForm && typeof els.contactForm.scrollIntoView === "function") {
      els.contactForm.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  // ── card_summary from the token intent ───────────────────────────────
  function cardSummaryFromIntent(intent) {
    var cardData = (intent && (intent.data || intent.card)) || {};
    var funding = typeof cardData.funding === "string" &&
      ["credit", "debit", "prepaid", "unknown"].indexOf(cardData.funding) !== -1
      ? cardData.funding : undefined;
    return {
      brand: typeof cardData.brand === "string" ? cardData.brand : undefined,
      last4: typeof cardData.last4 === "string" ? cardData.last4 : undefined,
      expiration_month: typeof cardData.expiration_month === "number" ? cardData.expiration_month : undefined,
      expiration_year: typeof cardData.expiration_year === "number" ? cardData.expiration_year : undefined,
      funding: funding,
      authentication: typeof cardData.authentication === "string" ? cardData.authentication : undefined,
      issuer_country_alpha2: cardData.issuer_country && typeof cardData.issuer_country.alpha2 === "string"
        ? cardData.issuer_country.alpha2 : undefined
    };
  }

  function makeIdempotencyKey(sid) {
    var rnd = (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
      ? crypto.randomUUID()
      : (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
    // Interleave `-x-` so no PAN-shaped contiguous digit run can form.
    return "bt-x-" + sid + "-x-" + rnd;
  }

  // ── pay-bt ───────────────────────────────────────────────────────────
  var payInFlight = false;
  function callPayBt(tokenIntentId, cardSummary, threeDsSessionId) {
    if (payInFlight) return;
    payInFlight = true;
    dispatch({ type: "pay.start" });
    var v = contactValues();
    apiJson("/api/checkout/veyra-pay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({
        session_id: sessionId,
        basis_theory_token_intent_id: tokenIntentId,
        card_summary: cardSummary,
        customer_name: v.name || undefined,
        customer_email: v.email || undefined,
        idempotency_key: makeIdempotencyKey(sessionId)
        // NO wallet_type on the card lane.
      }, threeDsSessionId ? { three_ds_session_id: threeDsSessionId } : {}))
    }).then(function (res) {
      var body = res.body || {};
      var status = body.public_status;
      if (status === "succeeded") {
        dispatch({ type: "pay.success" });
        window.location.href = "order-confirmed.html";
        return;
      }

      // Server-driven threshold-3DS: requires_action WITH a three_ds_session_id.
      var serverThreeDsSessionId = status === "requires_action" && typeof body.three_ds_session_id === "string"
        ? body.three_ds_session_id : null;
      var serverFingerprintUrl = status === "requires_action" && typeof body.device_fingerprint_url === "string"
        ? body.device_fingerprint_url : null;
      var serverChallengeUrl = status === "requires_action" && typeof body.three_ds_challenge_url === "string"
        ? body.three_ds_challenge_url : null;

      if (status === "requires_action" && serverThreeDsSessionId) {
        // Re-enter the 3DS flow; release the in-flight lock so the post-3DS
        // re-charge (which lands back in ready_to_pay) can dispatch pay again.
        payInFlight = false;
        paymentInputs = {
          tokenIntentId: tokenIntentId,
          cardSummary: cardSummary,
          threeDsSessionId: serverThreeDsSessionId
        };
        dispatch({ type: "three_ds.session.start" });
        dispatch({
          type: "three_ds.session.success",
          threeDsSessionId: serverThreeDsSessionId,
          deviceFingerprintUrl: serverFingerprintUrl,
          challengeUrl: serverChallengeUrl
        });
        return;
      }

      // Processor-hosted redirect 3DS: requires_action WITH a redirect_url
      // and no BT 3DS session — top-window redirect. No processor SDK.
      var redirectUrl = status === "requires_action" && !serverThreeDsSessionId &&
        typeof body.redirect_url === "string" ? body.redirect_url : null;
      if (redirectUrl) {
        try {
          if (window.top && window.top !== window) window.top.location.assign(redirectUrl);
          else window.location.assign(redirectUrl);
          return;
        } catch (e) { /* cross-origin frame — fall through to failure */ }
      }

      dispatch({ type: "pay.failed", message: GENERIC_ERROR });
    }).catch(function () {
      dispatch({ type: "pay.failed", message: GENERIC_ERROR });
    });
  }

  // ── 3ds session ──────────────────────────────────────────────────────
  function deviceInfo() {
    var s = (typeof screen !== "undefined") ? screen : {};
    return {
      browser_javascript_enabled: true,
      browser_java_enabled: (typeof navigator !== "undefined" && typeof navigator.javaEnabled === "function")
        ? Boolean(navigator.javaEnabled()) : false,
      browser_language: (typeof navigator !== "undefined" && navigator.language) || "en-US",
      browser_color_depth: String(s.colorDepth || 24),
      browser_screen_height: String(s.height || 1080),
      browser_screen_width: String(s.width || 1920),
      browser_tz: String(new Date().getTimezoneOffset()),
      browser_user_agent: (typeof navigator !== "undefined" && navigator.userAgent) || "Mozilla/5.0"
    };
  }

  function startThreeDs(tokenIntentId, cardSummary) {
    dispatch({ type: "three_ds.session.start" });
    apiJson("/api/checkout/veyra-3ds-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        basis_theory_token_intent_id: tokenIntentId,
        device_info: deviceInfo()
      })
    }).then(function (res) {
      if (res.status === 503) {
        // BT 3DS unavailable — pay directly so the real decline reason shows.
        dispatch({ type: "three_ds.session.skipped" });
        return;
      }
      if (!res.ok) {
        dispatch({ type: "three_ds.session.failed" });
        return;
      }
      var session = res.body || {};
      paymentInputs = {
        tokenIntentId: tokenIntentId,
        cardSummary: cardSummary,
        threeDsSessionId: session.session_id
      };
      dispatch({
        type: "three_ds.session.success",
        threeDsSessionId: session.session_id,
        deviceFingerprintUrl: session.device_fingerprint_url || null,
        challengeUrl: session.challenge_url || null
      });
    }).catch(function () {
      dispatch({ type: "three_ds.session.failed" });
    });
  }

  // ── 3ds authenticate (auto-fires on three_ds_authenticating) ─────────
  var authenticating = false;
  function runAuthenticate() {
    if (authenticating) return;
    if (!paymentInputs || !paymentInputs.threeDsSessionId) {
      dispatch({ type: "three_ds.authenticate.failed" });
      return;
    }
    authenticating = true;
    apiJson("/api/checkout/veyra-3ds-authenticate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        three_ds_session_id: paymentInputs.threeDsSessionId
      })
    }).then(function (res) {
      authenticating = false;
      if (res.status === 503) { dispatch({ type: "three_ds.session.unavailable" }); return; }
      if (res.status === 422) { dispatch({ type: "three_ds.authenticate.failed" }); return; }
      if (!res.ok) { dispatch({ type: "three_ds.authenticate.failed" }); return; }
      var body = res.body || {};
      var auth = normalizeAuthStatus(typeof body.authentication_status === "string" ? body.authentication_status : null);
      if (auth === "successful") dispatch({ type: "three_ds.authenticate.success" });
      else dispatch({ type: "three_ds.authenticate.failed" });
    }).catch(function () {
      authenticating = false;
      dispatch({ type: "three_ds.authenticate.failed" });
    });
  }

  // ── Pay handler (Phase 2) ────────────────────────────────────────────
  // Contact was validated and the session created in Phase 1 (Continue), so
  // this only needs to tokenize + pay. A defensive fallback returns the user
  // to Phase 1 if the session is somehow missing (e.g. after an Edit race).
  function handlePay() {
    clearError();

    if (!btReady || !cardEl) {
      showError("The card field is still loading. Please wait a moment and try again.");
      return;
    }
    if (!cardComplete) {
      showError("Please enter your card details to continue.");
      return;
    }
    if (!sessionId) {
      handleEdit();
      showContactError("Please re-confirm your details to continue.");
      return;
    }
    tokenizeAndPay();
  }

  function tokenizeAndPay() {
    paymentInputs = null;
    payInFlight = false;
    authenticating = false;
    dispatch({ type: "reset" });
    dispatch({ type: "tokenize.start" });

    var createPayload = { type: "card", data: cardEl };
    if (containerPath) {
      createPayload.containers = [containerPath];
      createPayload.metadata = { container_path: containerPath };
    }

    bt.tokenIntents.create(createPayload).then(function (intent) {
      var tokenIntentId = intent && intent.id;
      var valid = typeof tokenIntentId === "string" &&
        /^(ti_[a-zA-Z0-9_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(tokenIntentId);
      if (!valid) { dispatch({ type: "tokenize.failed" }); return; }

      var cardSummary = cardSummaryFromIntent(intent);
      var authentication = cardSummary.authentication || null;
      paymentInputs = { tokenIntentId: tokenIntentId, cardSummary: cardSummary, threeDsSessionId: null };
      dispatch({ type: "tokenize.success", tokenIntentId: tokenIntentId, authentication: authentication });

      if (authentication === "sca_required") {
        startThreeDs(tokenIntentId, cardSummary);
      } else {
        callPayBt(tokenIntentId, cardSummary, null);
      }
    }).catch(function () {
      dispatch({ type: "tokenize.failed" });
    });
  }

  // Phase 1 submit → Continue (create session with real metadata, mount card).
  els.contactForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    handleContinue();
  });
  // Clear the contact error as the user starts correcting fields.
  els.contactForm.addEventListener("input", clearContactError);

  // Phase 2 submit → Pay (tokenize + charge).
  els.payForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    handlePay();
  });

  // Edit link → back to Phase 1.
  if (els.edit) {
    els.edit.addEventListener("click", function (ev) {
      ev.preventDefault();
      handleEdit();
    });
  }

  // Start on Phase 1. No session or card mount happens until Continue, so the
  // VeyraGate session is always created AFTER the contact/shipping form is
  // filled — its metadata carries the real billing address (AVS) + customer
  // details (ops/fulfillment).
  showPhase("contact");
})();
