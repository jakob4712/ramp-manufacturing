/* Ramp Manufacturing Co. — site interactions + cart */
(function () {
  "use strict";

  /* ---- VeyraGate checkout config ----
     Public, publishable-site-key checkout (client-side). Fill in the
     Ramp Manufacturing site's publishable key to enable live session
     creation. When empty, checkout falls back to an emailed order. */
  var VEYRA = {
    base: "https://veyragate.com",
    siteKey: window.RAMP_VEYRA_SITE_KEY || "",
    currency: "usd"
  };

  /* ---------- Header ---------- */
  var header = document.querySelector(".site-header");
  var toggle = document.querySelector(".nav-toggle");
  if (toggle && header) {
    toggle.addEventListener("click", function () {
      header.classList.toggle("menu-open");
      toggle.setAttribute("aria-expanded", header.classList.contains("menu-open") ? "true" : "false");
    });
    header.querySelectorAll(".nav-links a").forEach(function (a) {
      a.addEventListener("click", function () { header.classList.remove("menu-open"); });
    });
  }

  /* ---------- Scroll reveal ---------- */
  var revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && revealEls.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { threshold: 0.1 });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("in"); });
  }

  /* ---------- FAQ ---------- */
  document.querySelectorAll(".faq-item").forEach(function (item) {
    var q = item.querySelector(".faq-q"), a = item.querySelector(".faq-a");
    if (!q || !a) return;
    q.addEventListener("click", function () {
      var open = item.classList.contains("open");
      document.querySelectorAll(".faq-item.open").forEach(function (o) {
        if (o !== item) { o.classList.remove("open"); var oa = o.querySelector(".faq-a"); if (oa) oa.style.maxHeight = null; }
      });
      item.classList.toggle("open", !open);
      a.style.maxHeight = !open ? a.scrollHeight + "px" : null;
      q.setAttribute("aria-expanded", !open ? "true" : "false");
    });
  });

  document.querySelectorAll("[data-year]").forEach(function (el) { el.textContent = new Date().getFullYear(); });

  /* ---------- Request / support forms (mailto, no backend) ---------- */
  document.querySelectorAll("form[data-mailto]").forEach(function (form) {
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var d = new FormData(form), lines = [], subjectBits = [];
      d.forEach(function (v, k) {
        if (k === "_subject") { subjectBits.push(v); return; }
        lines.push(k.replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }) + ": " + (v || "—"));
      });
      var to = form.getAttribute("data-mailto") || "support@rampmanufacturing.co";
      var subject = subjectBits.length ? subjectBits.join(" ") : "Website inquiry";
      var href = "mailto:" + to + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(lines.join("\n"));
      var ok = form.querySelector(".form-success");
      if (ok) { ok.classList.add("show"); ok.scrollIntoView({ behavior: "smooth", block: "center" }); }
      window.location.href = href;
      form.reset();
    });
  });

  /* ================= CART ================= */
  var KEY = "ramp_cart_v1";
  var cart = load();
  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; } }
  function save() { localStorage.setItem(KEY, JSON.stringify(cart)); render(); }
  function count() { return cart.reduce(function (n, i) { return n + i.qty; }, 0); }
  function total() { return cart.reduce(function (s, i) { return s + i.price * i.qty; }, 0); }
  function find(id) { return cart.filter(function (i) { return i.id === id; })[0]; }

  function add(p) {
    var e = find(p.id);
    if (e) e.qty += 1; else cart.push({ id: p.id, name: p.name, spec: p.spec, price: p.price, img: p.img, qty: 1 });
    save(); open();
  }
  function setQty(id, q) {
    var e = find(id); if (!e) return;
    e.qty = Math.max(0, q);
    if (e.qty === 0) cart = cart.filter(function (i) { return i.id !== id; });
    save();
  }
  function remove(id) { cart = cart.filter(function (i) { return i.id !== id; }); save(); }

  var drawer = document.querySelector(".cart-drawer");
  var overlay = document.querySelector(".cart-overlay");
  function open() { if (drawer) { drawer.classList.add("open"); overlay.classList.add("open"); document.body.style.overflow = "hidden"; } }
  function close() { if (drawer) { drawer.classList.remove("open"); overlay.classList.remove("open"); document.body.style.overflow = ""; } }

  function render() {
    document.querySelectorAll(".cart-count").forEach(function (el) { var c = count(); el.textContent = c; el.setAttribute("data-count", c); });
    var wrap = drawer && drawer.querySelector(".cart-items");
    if (!wrap) return;
    if (!cart.length) {
      wrap.innerHTML = '<div class="cart-empty">Your cart is empty.<br>Browse the <a href="materials.html" style="color:var(--brand)">catalog</a> to add cut-to-size stock and tooling.</div>';
    } else {
      wrap.innerHTML = cart.map(function (i) {
        return '<div class="cart-item">' +
          '<img src="' + i.img + '" alt="" />' +
          '<div><div class="ci-name">' + esc(i.name) + '</div><div class="ci-spec">' + esc(i.spec || "") + '</div>' +
          '<div class="cart-qty"><button data-dec="' + i.id + '" aria-label="Decrease">−</button><span>' + i.qty + '</span><button data-inc="' + i.id + '" aria-label="Increase">+</button></div></div>' +
          '<div class="ci-right"><div class="ci-price">$' + (i.price * i.qty).toFixed(2) + '</div><button class="ci-remove" data-rm="' + i.id + '">Remove</button></div>' +
          '</div>';
      }).join("");
    }
    var t = drawer.querySelector(".cart-total .amt"); if (t) t.textContent = "$" + total().toFixed(2);
    var co = drawer.querySelector("[data-checkout]"); if (co) co.disabled = !cart.length;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }

  document.addEventListener("click", function (ev) {
    var t = ev.target.closest("[data-add],[data-open-cart],[data-inc],[data-dec],[data-rm],[data-checkout],.cart-close");
    if (!t) return;
    if (t.hasAttribute("data-add")) {
      ev.preventDefault();
      add({ id: t.getAttribute("data-add"), name: t.getAttribute("data-name"), spec: t.getAttribute("data-spec"), price: parseFloat(t.getAttribute("data-price")), img: t.getAttribute("data-img") });
    } else if (t.hasAttribute("data-open-cart")) { ev.preventDefault(); render(); open(); }
    else if (t.hasAttribute("data-inc")) { var i = find(t.getAttribute("data-inc")); if (i) setQty(i.id, i.qty + 1); }
    else if (t.hasAttribute("data-dec")) { var d = find(t.getAttribute("data-dec")); if (d) setQty(d.id, d.qty - 1); }
    else if (t.hasAttribute("data-rm")) { remove(t.getAttribute("data-rm")); }
    else if (t.classList.contains("cart-close")) { close(); }
    else if (t.hasAttribute("data-checkout")) { checkout(t); }
  });
  if (overlay) overlay.addEventListener("click", close);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });

  /* ---------- Checkout via VeyraGate public session ---------- */
  function checkout(btn) {
    if (!cart.length) return;
    var cents = Math.round(total() * 100);
    var desc = "Ramp Manufacturing order — " + count() + " item" + (count() > 1 ? "s" : "");
    var summary = cart.map(function (i) { return i.qty + "x " + i.name + (i.spec ? " (" + i.spec + ")" : ""); }).join("; ");
    if (!VEYRA.siteKey) {
      var body = "I'd like to place this order:\n\n" + cart.map(function (i) {
        return i.qty + " x " + i.name + (i.spec ? " " + i.spec : "") + " @ $" + i.price.toFixed(2) + " = $" + (i.price * i.qty).toFixed(2);
      }).join("\n") + "\n\nOrder total: $" + total().toFixed(2);
      window.location.href = "mailto:support@rampmanufacturing.co?subject=" + encodeURIComponent("New order — $" + total().toFixed(2)) + "&body=" + encodeURIComponent(body);
      return;
    }
    var old = btn.textContent; btn.textContent = "Starting secure checkout…"; btn.disabled = true;
    fetch(VEYRA.base + "/api/v1/public/checkout_sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Veyra-Site-Key": VEYRA.siteKey },
      body: JSON.stringify({
        amount_cents: cents, currency: VEYRA.currency, description: desc,
        return_url: window.location.origin + "/order-confirmed.html",
        metadata: { vg_merchant_ref: summary.slice(0, 190) }
      })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.checkout_url) { window.location.href = j.checkout_url; }
      else { throw new Error(j && j.error ? j.error : "session failed"); }
    }).catch(function () {
      btn.textContent = old; btn.disabled = false;
      alert("We couldn't start checkout just now. Please try again or email support@rampmanufacturing.co and we'll invoice you directly.");
    });
  }

  render();
})();
