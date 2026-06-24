/* AI Size Recommender — storefront widget, built on tryonai-kit.js so it looks
 * and loads exactly like the try-on. Powers the standalone "Find my size" button
 * and exposes window.TryonaiSize for the Outfit Stylist + try-on to reuse. */
(function () {
  "use strict";
  if (window.__tryonaiSizeBooted) return;
  window.__tryonaiSizeBooted = true;
  var K = window.TryonaiKit;
  if (!K) { console.warn("[tryonai] kit not loaded"); return; }

  var STORE_KEY = "tryonai_biometrics";
  var SIZE_STEPS = [
    { glyph: "ruler", label: "Reading your measurements" },
    { glyph: "search", label: "Matching the size chart" },
    { glyph: "fit", label: "Checking stock" },
    { glyph: "check", label: "Finding your fit" },
  ];
  var DISCLAIMER =
    "An estimate from your measurements; fit varies by brand, so double-check if you're between sizes.";

  function boot() { document.querySelectorAll(".tryonai-size-root").forEach(initRoot); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  function initRoot(root) {
    var launcher = root.querySelector(".tryonai-k-launcher");
    if (!launcher) return;
    var ctx = {
      theme: root.dataset.theme || "atelier",
      shape: root.dataset.buttonShape || "pill",
      accent: root.style.getPropertyValue("--tryonai-accent") || "",
      hideRoot: function () { root.style.display = "none"; },
    };
    var product = {
      handle: root.dataset.productHandle || "",
      title: root.dataset.productTitle || "",
      image: root.dataset.productImageUrl || null,
    };
    launcher.addEventListener("click", function () {
      openSizeFlow([{ handle: product.handle, colorHint: null, title: product.title, image: product.image }], null, ctx);
    });
    // Expose for the combined launcher (chooser) to start this flow directly.
    root.__tryonaiOpen = function () {
      openSizeFlow([{ handle: product.handle, colorHint: null, title: product.title, image: product.image }], null, ctx);
    };
  }

  // Public API for outfit.js / tryon.js.
  window.TryonaiSize = {
    open: function (products, onApply, ctx) { openSizeFlow(products, onApply, ctx || {}); },
    getBiometrics: loadBio,
  };

  function openSizeFlow(products, onApply, ctx) {
    var ui = K.createModal({ theme: ctx.theme, shape: ctx.shape, accent: ctx.accent });
    var state = { bio: loadBio() || defaultBio(), consent: false, journey: null };
    ui.open();
    renderForm();

    function renderForm() {
      var b = state.bio;
      ui.content.innerHTML =
        '<header class="tryonai-k-head"><h2 class="tryonai-k-title">Find your size</h2>' +
        '<p class="tryonai-k-sub">Tell us a little about you and we\'ll suggest the best size for each piece.</p></header>' +
        field("Gender", chips("gender", [["womens", "Women's"], ["mens", "Men's"], ["unisex", "Unisex"]], b.gender)) +
        '<div class="tryonai-sz-form-grid">' +
          field("Height", heightRow(b)) +
          field("Weight", weightRow(b)) +
        "</div>" +
        field("Body build", chips("build", [["slim", "Slim"], ["average", "Average"], ["broad", "Broad"]], b.build)) +
        field("Fit you like", chips("fit", [["fitted", "Fitted"], ["relaxed", "Relaxed"], ["oversized", "Oversized"]], b.fit)) +
        field("Shoe size (optional)", shoeRow(b));
      ui.foot.innerHTML =
        '<label class="tryonai-k-consent"><input type="checkbox" class="sz-consent"' + (state.consent ? " checked" : "") + ">" +
        '<span class="tryonai-k-consent__box"><svg viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 6.2l4 4L14.5 1.5"/></svg></span>' +
        "<span>Use my measurements to suggest sizes. They're sent to OpenAI to calculate and are not stored by this app.</span></label>" +
        '<button type="button" class="tryonai-k-cta sz-go"' + (canSubmit() ? "" : " disabled") + '>' +
        '<span>Find my size</span><span class="tryonai-k-cta__arrow">&rarr;</span></button>';
      wireForm();
    }

    function wireForm() {
      ui.content.querySelectorAll(".tryonai-k-chip").forEach(function (chip) {
        chip.addEventListener("click", function () {
          state.bio[chip.dataset.group] = chip.dataset.value;
          renderForm();
        });
      });
      ui.content.querySelectorAll("[data-seg]").forEach(function (seg) {
        seg.querySelectorAll("button").forEach(function (btn) {
          btn.addEventListener("click", function () {
            state.bio[seg.dataset.seg] = btn.dataset.value;
            renderForm();
          });
        });
      });
      ui.content.querySelectorAll("input[data-bio]").forEach(function (inp) {
        inp.addEventListener("input", function () {
          state.bio[inp.dataset.bio] = inp.value === "" ? "" : Number(inp.value);
          // Keep canonical cm/kg current so a unit toggle re-renders correctly
          // and the CTA enables/disables live.
          computeHeightCm(state.bio);
          computeWeightKg(state.bio);
          syncGo();
        });
      });
      var consent = ui.foot.querySelector(".sz-consent");
      if (consent) consent.addEventListener("change", function () { state.consent = consent.checked; syncGo(); });
      var go = ui.foot.querySelector(".sz-go");
      if (go) go.addEventListener("click", submit);
    }

    function syncGo() {
      var go = ui.foot.querySelector(".sz-go");
      if (go) go.disabled = !canSubmit();
    }
    function canSubmit() {
      var h = computeHeightCm(state.bio), w = computeWeightKg(state.bio);
      return state.consent && h > 0 && w > 0;
    }

    function submit() {
      if (!canSubmit()) return;
      var bio = {
        heightCm: computeHeightCm(state.bio),
        weightKg: computeWeightKg(state.bio),
        build: state.bio.build || "average",
        gender: state.bio.gender || "unisex",
        fit: state.bio.fit || "relaxed",
        shoeSizeRaw: state.bio.shoe ? Number(state.bio.shoe) : undefined,
        shoeSystem: state.bio.shoeSystem || "US",
      };
      saveBio(state.bio); // persist raw form (with units) for next time
      renderLoading();

      // K.fetchJson never throws on a non-JSON body (e.g. an app-proxy error page
      // when the size backend isn't deployed) — so WebKit's cryptic parser error
      // can't reach a shopper.
      K.fetchJson("/apps/tryonai/size", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ biometrics: bio, products: products.map(function (p) { return { handle: p.handle, colorHint: p.colorHint || null }; }) }),
      })
        .then(function (r) {
          // 404 = feature off; non-JSON error (!ok, no data) = backend not wired
          // up. Either way, hide the button rather than error at the shopper.
          if (r.status === 404 || (!r.ok && !r.data)) { if (ctx.hideRoot) ctx.hideRoot(); return ui.close(); }
          if (!r.ok) { if (state.journey) state.journey.destroy(); return showSizeError(); }
          var data = r.data || {};
          state.lastRequestId = data.requestId || null;
          if (state.journey) state.journey.finish();
          setTimeout(function () { renderResults(data.results || []); }, 380);
        })
        .catch(function (err) {
          if (state.journey) state.journey.destroy();
          console.warn("[tryonai] size error:", err);
          showSizeError();
        });
    }

    function showSizeError() {
      ui.content.innerHTML =
        '<header class="tryonai-k-head"><h2 class="tryonai-k-title">That didn\'t work</h2>' +
        '<p class="tryonai-k-sub">We couldn\'t calculate sizes just now — please pick your size on the product page.</p></header>';
      ui.foot.innerHTML = '<button type="button" class="tryonai-k-cta sz-close"><span>Close</span></button>';
      var c = ui.foot.querySelector(".sz-close"); if (c) c.addEventListener("click", ui.close);
    }

    function renderLoading() {
      ui.content.innerHTML = "";
      ui.foot.innerHTML = "";
      state.journey = K.createJourney(ui.content, SIZE_STEPS, { stepMs: 1100 });
    }

    function renderResults(results) {
      var byHandle = {};
      results.forEach(function (r) { byHandle[r.handle] = r; });

      var cards = products.map(function (p) {
        var r = byHandle[p.handle] || { status: "uncertain" };
        return (
          '<div class="tryonai-sz-result">' +
          '<div class="tryonai-sz-result__thumb">' + (p.image ? '<img src="' + K.esc(p.image) + '" alt="">' : "") + "</div>" +
          '<div class="tryonai-sz-result__meta">' +
          '<span class="tryonai-sz-result__title">' + K.esc(p.title || p.handle) + "</span>" +
          sizeChip(r) +
          (noteFor(r) ? '<span class="tryonai-sz-result__note">' + K.esc(noteFor(r)) + "</span>" : "") +
          "</div></div>"
        );
      }).join("");

      var addable = results.filter(function (r) { return r.variantId && (r.status === "ok" || r.status === "substituted" || r.status === "no_size_option"); });

      ui.content.innerHTML =
        '<header class="tryonai-k-head"><h2 class="tryonai-k-title">Your size</h2></header>' +
        '<div class="tryonai-sz-results">' + cards + "</div>" +
        '<p class="tryonai-k-disclaimer">' + K.esc(DISCLAIMER) + "</p>";

      if (onApply) {
        ui.foot.innerHTML = '<button type="button" class="tryonai-k-cta sz-apply"><span>Use these sizes</span><span class="tryonai-k-cta__arrow">&rarr;</span></button>';
        ui.foot.querySelector(".sz-apply").addEventListener("click", function () {
          onApply(byHandle); ui.close();
        });
      } else if (addable.length > 0) {
        ui.foot.innerHTML = '<button type="button" class="tryonai-k-cta sz-add"><span>Add to cart</span><span class="tryonai-k-cta__arrow">&rarr;</span></button>';
        ui.foot.querySelector(".sz-add").addEventListener("click", function () { addToCart(addable); });
      } else {
        ui.foot.innerHTML = '<button type="button" class="tryonai-k-cta sz-close"><span>Choose your size on the page</span></button>';
        ui.foot.querySelector(".sz-close").addEventListener("click", ui.close);
      }
    }

    function addToCart(addable) {
      var btn = ui.foot.querySelector(".sz-add");
      if (btn) btn.disabled = true;
      var items = addable.map(function (r) { return { id: Number(r.variantId), quantity: 1, properties: { _tryonai_size: "1" } }; });
      fetch("/cart/add.js", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify({ items: items }),
      })
        .then(function (res) { if (!res.ok) throw new Error("add failed"); return res.json(); })
        .then(function (added) {
          var addedItems = added && added.items ? added.items : [];
          addedItems.forEach(function (it) {
            beacon(state.lastRequestId, it.variant_id || it.id, it);
          });
          ["tryonai:added-to-cart", "cart:refresh", "cart:updated"].forEach(function (n) { document.dispatchEvent(new CustomEvent(n)); });
          K.confirmCartAdd(ui, addedItems);
        })
        .catch(function () { if (btn) btn.disabled = false; ui.setError("Add to cart failed — please try on the page."); });
    }

    // capture requestId for the (optional) attribution beacon
    function beacon(requestId, variantId, item) {
      try {
        if (!requestId) return;
        var toInt = function (v) { var n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; };
        var currency = (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || null;
        fetch("/apps/tryonai/cart-event", {
          method: "POST", credentials: "same-origin", keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: requestId, productHandle: null, variantId: variantId != null ? String(variantId) : null,
            quantity: (item && toInt(item.quantity)) || 1, priceCents: item ? toInt(item.price) : null,
            lineValueCents: item ? toInt(item.final_line_price != null ? item.final_line_price : item.line_price) : null, currency: currency,
          }),
        }).catch(function () { /* noop */ });
      } catch (_) { /* noop */ }
    }

  }

  // ---- form field builders -------------------------------------------------

  function field(label, inner) {
    return '<div class="tryonai-k-field"><span class="tryonai-k-label">' + K.esc(label) + "</span>" + inner + "</div>";
  }
  function chips(group, opts, val) {
    return '<div class="tryonai-k-chips">' + opts.map(function (o) {
      return '<button type="button" class="tryonai-k-chip' + (val === o[0] ? " is-on" : "") + '" data-group="' + group + '" data-value="' + o[0] + '">' + K.esc(o[1]) + "</button>";
    }).join("") + "</div>";
  }
  function seg(name, opts, val) {
    return '<div class="tryonai-k-seg" data-seg="' + name + '">' + opts.map(function (o) {
      return '<button type="button" class="' + (val === o[0] ? "is-on" : "") + '" data-value="' + o[0] + '">' + K.esc(o[1]) + "</button>";
    }).join("") + "</div>";
  }
  function heightRow(b) {
    if (b.unitH === "ftin") {
      var ft = b.heightCm ? Math.floor((b.heightCm / 2.54) / 12) : "";
      var inch = b.heightCm ? Math.round((b.heightCm / 2.54) - ft * 12) : "";
      return '<div class="tryonai-k-row">' +
        '<input class="tryonai-k-input" type="number" inputmode="numeric" placeholder="ft" data-bio="hFt" value="' + ft + '" style="max-width:90px">' +
        '<input class="tryonai-k-input" type="number" inputmode="numeric" placeholder="in" data-bio="hIn" value="' + inch + '" style="max-width:90px">' +
        seg("unitH", [["cm", "cm"], ["ftin", "ft/in"]], "ftin") + "</div>";
    }
    return '<div class="tryonai-k-row"><input class="tryonai-k-input" type="number" inputmode="numeric" placeholder="cm" data-bio="hCm" value="' + (b.heightCm || "") + '">' +
      seg("unitH", [["cm", "cm"], ["ftin", "ft/in"]], "cm") + "</div>";
  }
  function weightRow(b) {
    if (b.unitW === "lb") {
      var lb = b.weightKg ? Math.round(b.weightKg / 0.453592) : "";
      return '<div class="tryonai-k-row"><input class="tryonai-k-input" type="number" inputmode="numeric" placeholder="lb" data-bio="wLb" value="' + lb + '">' +
        seg("unitW", [["kg", "kg"], ["lb", "lb"]], "lb") + "</div>";
    }
    return '<div class="tryonai-k-row"><input class="tryonai-k-input" type="number" inputmode="numeric" placeholder="kg" data-bio="wKg" value="' + (b.weightKg || "") + '">' +
      seg("unitW", [["kg", "kg"], ["lb", "lb"]], "kg") + "</div>";
  }
  function shoeRow(b) {
    return '<div class="tryonai-k-row"><input class="tryonai-k-input" type="number" inputmode="decimal" step="0.5" placeholder="e.g. 9" data-bio="shoe" value="' + (b.shoe || "") + '">' +
      seg("shoeSystem", [["US", "US"], ["EU", "EU"], ["UK", "UK"]], b.shoeSystem || "US") + "</div>";
  }

  // ---- unit math + persistence ---------------------------------------------

  function computeHeightCm(b) {
    if (b.unitH === "ftin") {
      var ft = Number(b.hFt) || 0, inch = Number(b.hIn) || 0;
      var cm = (ft * 12 + inch) * 2.54;
      if (cm > 0) b.heightCm = Math.round(cm);
      return cm;
    }
    var c = Number(b.hCm) || Number(b.heightCm) || 0;
    if (c > 0) b.heightCm = c;
    return c;
  }
  function computeWeightKg(b) {
    if (b.unitW === "lb") {
      var kg = (Number(b.wLb) || 0) * 0.453592;
      if (kg > 0) b.weightKg = Math.round(kg);
      return kg;
    }
    var k = Number(b.wKg) || Number(b.weightKg) || 0;
    if (k > 0) b.weightKg = k;
    return k;
  }
  function defaultBio() { return { unitH: "cm", unitW: "kg", gender: "", build: "average", fit: "relaxed", shoeSystem: "US" }; }
  function loadBio() {
    try { var raw = localStorage.getItem(STORE_KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }
  function saveBio(b) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(b)); } catch (_) { /* noop */ }
  }

  // ---- result chips --------------------------------------------------------

  function sizeChip(r) {
    if (r.status === "no_size_option") return '<span class="tryonai-k-sizechip">One size</span>';
    if (r.status === "out_of_stock") return '<span class="tryonai-k-sizechip" data-oos="1">Sold out</span>';
    if (r.status === "uncertain" || !r.size) return '<span class="tryonai-k-sizechip" data-oos="1">Pick your size</span>';
    return '<span class="tryonai-k-sizechip"' + (r.status === "substituted" ? ' data-sub="1"' : "") + '>Your size · ' + K.esc(r.size) + "</span>";
  }
  function noteFor(r) {
    if (r.status === "substituted") return r.note || "Closest in-stock size.";
    if (r.status === "out_of_stock") return "Sold out in all sizes.";
    if (r.status === "uncertain") return "Choose your size on the product page.";
    return "";
  }
})();
