/* AI Outfit Stylist — storefront widget, rebuilt on tryonai-kit.js so it looks
 * and loads exactly like the try-on (Atelier/noir/gallery, the journey loader).
 * Flow: mode -> quiz -> build outfit -> (optionally) get sizes / try the look on
 * -> add every piece to cart with per-piece commission attribution. */
(function () {
  "use strict";
  if (window.__tryonaiOutfitBooted) return;
  window.__tryonaiOutfitBooted = true;
  var K = window.TryonaiKit;
  if (!K) { console.warn("[tryonai] kit not loaded"); return; }

  var QUIZ = [
    { id: "occasion", q: "What are you dressing for?", options: [["everyday", "Everyday"], ["work", "Work"], ["date", "Date night"], ["event", "Event"], ["active", "Active"]] },
    { id: "palette", q: "Which colors feel like you?", options: [["warm", "Warm tones"], ["cool", "Cool tones"], ["neutral", "Neutrals"], ["bold", "Bold & bright"]] },
    { id: "vibe", q: "What's your vibe?", options: [["classic", "Classic"], ["casual", "Casual"], ["streetwear", "Streetwear"], ["elegant", "Elegant"], ["minimal", "Minimal"]] },
    { id: "fit", q: "Preferred fit?", options: [["fitted", "Fitted"], ["relaxed", "Relaxed"], ["oversized", "Oversized"]] },
    { id: "budget", q: "Budget?", options: [["best", "Show me the best"], ["affordable", "Keep it affordable"]] },
  ];
  var BUILD_STEPS = [
    { glyph: "palette", label: "Reading your style" }, { glyph: "fabric", label: "Matching colors" },
    { glyph: "search", label: "Pulling pieces" }, { glyph: "finish", label: "Composing the look" },
  ];
  var TRYON_STEPS = [
    { glyph: "eye", label: "Reading your photo" }, { glyph: "pose", label: "Finding your pose" },
    { glyph: "fabric", label: "Placing the pieces" }, { glyph: "drape", label: "Draping the fabric" },
    { glyph: "light", label: "Matching the light" }, { glyph: "finish", label: "Finishing the look" },
  ];

  function boot() { document.querySelectorAll(".tryonai-outfit-root").forEach(initRoot); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  function initRoot(root) {
    var launcher = root.querySelector(".tryonai-k-launcher");
    if (!launcher) return;
    var ctx = { theme: root.dataset.theme || "atelier", shape: root.dataset.buttonShape || "pill", accent: root.style.getPropertyValue("--tryonai-accent") || "" };
    var anchor = {
      id: root.dataset.productId || "", handle: root.dataset.productHandle || "",
      title: root.dataset.productTitle || "", image: normImg(root.dataset.productImageUrl), variantId: root.dataset.productVariantId || null,
    };
    launcher.addEventListener("click", function () { openOutfit(ctx, anchor, root); });
    // Expose for the combined launcher (chooser) to start this flow directly.
    root.__tryonaiOpen = function () { openOutfit(ctx, anchor, root); };
  }

  function openOutfit(ctx, anchor, root) {
    var ui = K.createModal({ theme: ctx.theme, shape: ctx.shape, accent: ctx.accent });
    var state = { mode: "anchor", answers: {}, qi: 0, outfit: null, reqId: null, selected: {}, sizes: {}, selfie: null, selfiePreview: null, size: "1024x1536", consent: false, resultB64: null, journey: null, abort: null };
    ui.open();
    renderIntro();

    function renderIntro() {
      ui.content.innerHTML =
        '<header class="tryonai-k-head"><h2 class="tryonai-k-title">Let\'s build your look</h2>' +
        '<p class="tryonai-k-sub">Answer a few quick questions and we\'ll style a full outfit from this store — then try the whole thing on.</p></header>' +
        '<div class="tryonai-of-modes">' +
        '<button type="button" class="tryonai-of-mode" data-mode="anchor">' + (anchor.image ? '<img src="' + K.esc(anchor.image) + '" alt="">' : '<span class="tryonai-of-mode__icon">◇</span>') +
        '<span class="tryonai-of-mode__t">Complete this look</span><span class="tryonai-of-mode__d">Build an outfit around the item you\'re viewing</span></button>' +
        '<button type="button" class="tryonai-of-mode" data-mode="scratch"><span class="tryonai-of-mode__icon">✦</span>' +
        '<span class="tryonai-of-mode__t">Style me from scratch</span><span class="tryonai-of-mode__d">A full head-to-toe outfit from your answers</span></button></div>';
      ui.foot.innerHTML = "";
      ui.content.querySelectorAll(".tryonai-of-mode").forEach(function (btn) {
        btn.addEventListener("click", function () { state.mode = btn.dataset.mode; state.qi = 0; state.answers = {}; renderQuiz(); });
      });
    }

    function renderQuiz() {
      var q = QUIZ[state.qi];
      var dots = QUIZ.map(function (_, i) { return '<span class="tryonai-of-dot' + (i <= state.qi ? " is-on" : "") + '"></span>'; }).join("");
      ui.content.innerHTML =
        '<header class="tryonai-k-head"><div class="tryonai-of-dots">' + dots + '</div><h2 class="tryonai-k-title">' + K.esc(q.q) + "</h2></header>" +
        '<div class="tryonai-k-chips">' + q.options.map(function (o) {
          return '<button type="button" class="tryonai-k-chip' + (state.answers[q.id] === o[0] ? " is-on" : "") + '" data-value="' + o[0] + '">' + K.esc(o[1]) + "</button>";
        }).join("") + "</div>" +
        '<div class="tryonai-of-foot-row"><button type="button" class="tryonai-k-link" data-back>&larr; Back</button></div>';
      ui.foot.innerHTML = "";
      ui.content.querySelectorAll(".tryonai-k-chip").forEach(function (chip) {
        chip.addEventListener("click", function () {
          state.answers[q.id] = chip.dataset.value;
          if (state.qi < QUIZ.length - 1) { state.qi++; renderQuiz(); } else submitOutfit();
        });
      });
      ui.content.querySelector("[data-back]").addEventListener("click", function () {
        if (state.qi > 0) { state.qi--; renderQuiz(); } else renderIntro();
      });
    }

    function submitOutfit() {
      ui.content.innerHTML = ""; ui.foot.innerHTML = "";
      state.journey = K.createJourney(ui.content, BUILD_STEPS, { stepMs: 1200 });
      // K.fetchJson never throws on a non-JSON body — so an app-proxy "Bad
      // Request"/HTML page (e.g. backend not deployed) can't surface WebKit's
      // cryptic "The string did not match the expected pattern." to a shopper.
      K.fetchJson("/apps/tryonai/outfit", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ mode: state.mode, answers: state.answers, anchor: state.mode === "anchor" ? anchor : null }),
      })
        .then(function (r) {
          if (state.journey) state.journey.finish();
          // 404 = feature flag off; a non-JSON error (!ok with no data) = backend
          // not deployed / proxy or auth failure. Either way the beta isn't wired
          // up here, so hide the launcher instead of showing the shopper an error.
          if (r.status === 404 || (!r.ok && !r.data)) { if (root) root.style.display = "none"; return ui.close(); }
          var data = r.data;
          if (!r.ok) return void setTimeout(function () { showBuildError(data && data.error); }, 380);
          if (!data || !data.outfit || !(data.outfit.pieces || []).length) return setTimeout(showEmpty, 380);
          state.outfit = data.outfit; state.reqId = data.requestId || null; state.selected = {};
          data.outfit.pieces.forEach(function (p) { if (p.variantId) state.selected[p.handle] = String(p.variantId); });
          setTimeout(renderOutfit, 380);
        })
        .catch(function (err) {
          // fetchJson resolves rather than rejects; this only fires on a real bug.
          if (state.journey) state.journey.destroy();
          console.warn("[tryonai] outfit build error:", err);
          showBuildError(null);
        });
    }

    function showEmpty() {
      ui.content.innerHTML =
        '<header class="tryonai-k-head"><h2 class="tryonai-k-title">No full look here</h2>' +
        '<p class="tryonai-k-sub">This store may not have enough matching pieces in stock right now.</p></header>';
      ui.foot.innerHTML = '<button type="button" class="tryonai-k-cta" data-restart><span>Start over</span></button>';
      ui.foot.querySelector("[data-restart]").addEventListener("click", renderIntro);
    }

    function showBuildError(code) {
      var msg = code === "rate_limited"
        ? "Too many requests — please wait a moment and try again."
        : "We couldn't build an outfit just now. Please try again.";
      ui.content.innerHTML =
        '<header class="tryonai-k-head"><h2 class="tryonai-k-title">That didn\'t work</h2>' +
        '<p class="tryonai-k-sub">' + K.esc(msg) + "</p></header>";
      ui.foot.innerHTML = '<button type="button" class="tryonai-k-cta" data-restart><span>Start over</span></button>';
      ui.foot.querySelector("[data-restart]").addEventListener("click", renderIntro);
    }

    function renderOutfit() {
      var pieces = state.outfit.pieces || [];
      var total = pieces.reduce(function (s, p) { var v = currentVariant(p); return s + ((v ? v.price : p.price) || 0); }, 0);
      ui.content.innerHTML =
        '<header class="tryonai-k-head"><h2 class="tryonai-k-title">Your outfit</h2>' +
        (state.outfit.rationale ? '<p class="tryonai-k-sub">' + K.esc(state.outfit.rationale) + "</p>" : "") + "</header>" +
        '<div class="tryonai-k-grid">' + pieces.map(renderCard).join("") + "</div>";
      ui.foot.innerHTML =
        '<div class="tryonai-of-cta-row"><span class="tryonai-of-total">Total ' + K.money(total) + "</span>" +
        '<button type="button" class="tryonai-k-action" data-sizes>Get my sizes</button>' +
        '<button type="button" class="tryonai-k-action" data-tryon>Try the look on</button>' +
        '<button type="button" class="tryonai-k-cta" data-addall><span>Add all to cart</span><span class="tryonai-k-cta__arrow">&rarr;</span></button></div>';
      ui.content.querySelectorAll(".tryonai-k-select").forEach(function (sel) {
        sel.addEventListener("change", function () { state.selected[sel.dataset.handle] = sel.value; });
      });
      ui.foot.querySelector("[data-sizes]").addEventListener("click", getSizes);
      ui.foot.querySelector("[data-tryon]").addEventListener("click", startTryOn);
      ui.foot.querySelector("[data-addall]").addEventListener("click", addAll);
    }

    function renderCard(p) {
      var sz = state.sizes[p.handle];
      var chip = sz && sz.size ? '<span class="tryonai-k-sizechip"' + (sz.status === "substituted" ? ' data-sub="1"' : "") + '>Size · ' + K.esc(sz.size) + "</span>" : "";
      var sel = "";
      if (p.variants && p.variants.length > 1) {
        var opts = p.variants.filter(function (v) { return v.available; }); if (!opts.length) opts = p.variants;
        sel = '<select class="tryonai-k-select" data-handle="' + K.esc(p.handle) + '">' + opts.map(function (v) {
          var label = v.options && v.options.length ? v.options.join(" / ") : "Default";
          return '<option value="' + K.esc(v.id) + '"' + (String(state.selected[p.handle]) === String(v.id) ? " selected" : "") + ">" + K.esc(label) + "</option>";
        }).join("") + "</select>";
      }
      return '<div class="tryonai-k-card">' + (p.image ? '<div class="tryonai-k-card__img"><img src="' + K.esc(p.image) + '" alt="' + K.esc(p.title) + '"></div>' : "") +
        '<div class="tryonai-k-card__body"><span class="tryonai-k-card__slot">' + K.esc(slotLabel(p.slot)) + (p.isAnchor ? " · your pick" : "") + "</span>" +
        '<span class="tryonai-k-card__title">' + K.esc(p.title) + '</span><span class="tryonai-k-card__price">' + K.money(p.price) + "</span>" +
        chip + (p.reason ? '<span class="tryonai-k-card__reason">' + K.esc(p.reason) + "</span>" : "") + sel + "</div></div>";
    }

    function getSizes() {
      if (!window.TryonaiSize) { ui.setError("Size finder isn't available right now."); return; }
      var products = (state.outfit.pieces || []).map(function (p) { return { handle: p.handle, colorHint: p.colorName || null, title: p.title, image: p.image }; });
      window.TryonaiSize.open(products, function (byHandle) {
        Object.keys(byHandle).forEach(function (h) {
          var r = byHandle[h];
          if (r && r.variantId) state.selected[h] = String(r.variantId);
          if (r && (r.size || r.status)) state.sizes[h] = { size: r.size, status: r.status };
        });
        renderOutfit();
      }, ctx);
    }

    function startTryOn() { state.resultB64 = null; renderTryOn(); }

    function renderTryOn() {
      ui.content.innerHTML =
        '<header class="tryonai-k-head"><h2 class="tryonai-k-title">Try the outfit on</h2></header>' +
        '<div class="tryonai-of-stage">' +
        (state.selfie ? '<img class="tryonai-of-selfie" src="' + state.selfiePreview + '" alt="">'
          : '<div class="tryonai-of-drop"><button type="button" class="tryonai-k-action" data-pick>Add your photo</button>' +
            '<input type="file" class="of-selfie-input" accept="image/jpeg,image/png,image/webp" hidden></div>') +
        "</div>";
      ui.foot.innerHTML =
        '<label class="tryonai-k-consent"><input type="checkbox" class="of-consent"' + (state.consent ? " checked" : "") + ">" +
        '<span class="tryonai-k-consent__box"><svg viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 6.2l4 4L14.5 1.5"/></svg></span>' +
        "<span>I agree to processing my photo for this try-on. Your photo is sent to OpenAI and is not stored by this app.</span></label>" +
        '<div class="tryonai-of-foot-row"><button type="button" class="tryonai-k-link" data-back>&larr; Back to outfit</button>' +
        '<button type="button" class="tryonai-k-cta" data-run' + (state.selfie && state.consent ? "" : " disabled") + '><span>Try it on</span><span class="tryonai-k-cta__arrow">&rarr;</span></button></div>';
      var pick = ui.content.querySelector("[data-pick]");
      if (pick) pick.addEventListener("click", function () { ui.content.querySelector(".of-selfie-input").click(); });
      var input = ui.content.querySelector(".of-selfie-input");
      if (input) input.addEventListener("change", function () { handleSelfie(input.files && input.files[0]); });
      ui.foot.querySelector("[data-back]").addEventListener("click", renderOutfit);
      var consent = ui.foot.querySelector(".of-consent");
      consent.addEventListener("change", function () { state.consent = consent.checked; var r = ui.foot.querySelector("[data-run]"); if (r) r.disabled = !(state.consent && state.selfie); });
      var run = ui.foot.querySelector("[data-run]");
      if (run) run.addEventListener("click", function () { runTryOn("combined"); });
    }

    function handleSelfie(file) {
      if (!file) return;
      K.downsampleImage(file, 1024).then(function (out) {
        state.selfie = out.file; state.size = K.pickSizeFromRatio(out.width, out.height); state.selfiePreview = URL.createObjectURL(out.file);
        renderTryOn();
      }).catch(function () { ui.setError("That image couldn't be read. Try another photo."); });
    }

    function runTryOn(mode) {
      if (!state.selfie) return;
      var garments = (state.outfit.pieces || []).filter(function (p) { return p.image; }).map(function (p) { return { url: p.image, label: p.slot }; });
      ui.content.innerHTML = ""; ui.foot.innerHTML = "";
      state.journey = K.createJourney(ui.content, TRYON_STEPS, { stepMs: 2600, photoUrl: state.selfiePreview });
      var fd = new FormData();
      fd.append("selfie", state.selfie, "selfie.jpg");
      fd.append("garments", JSON.stringify(garments));
      fd.append("mode", mode);
      fd.append("size", state.size);
      if (state.reqId) fd.append("outfit_request_id", state.reqId);
      state.abort = new AbortController();
      fetch("/apps/tryonai/outfit-tryon", { method: "POST", credentials: "same-origin", headers: { Accept: "text/event-stream" }, body: fd, signal: state.abort.signal })
        .then(function (res) {
          if (!res.ok || !res.body) {
            // Read the error body as text and parse defensively — a non-JSON
            // response must not throw a raw parser error to the catch below.
            return res.text().then(function (t) {
              var code = null; if (t) { try { code = (JSON.parse(t) || {}).error; } catch (_) { /* non-JSON */ } }
              throw K.uiError(tryonErr(code));
            });
          }
          return K.readSSE(res, onTryOnEvent);
        })
        .then(function () { if (state.journey) state.journey.finish(); setTimeout(showResult, 380); })
        .catch(function (err) {
          if (state.journey) state.journey.destroy();
          if (err && err.name === "AbortError") return;
          // Only show messages we authored (K.uiError); never a raw DOMException.
          if (!(err && err.tryonaiSafe)) console.warn("[tryonai] outfit try-on error:", err);
          ui.setError(err && err.tryonaiSafe ? err.message : "Try-on failed. Please try again.");
          setTimeout(renderTryOn, 100);
        });
    }

    function onTryOnEvent(evt) {
      if (evt.kind === "partial" || evt.kind === "preview") { if (evt.b64) state.resultB64 = evt.b64; if (state.journey) state.journey.nudge(); }
      else if (evt.kind === "completed") state.resultB64 = evt.b64;
      else if (evt.kind === "error") throw K.uiError(tryonErr(evt.error));
    }

    function showResult() {
      ui.content.innerHTML =
        '<header class="tryonai-k-head"><h2 class="tryonai-k-title">Your outfit, on you</h2></header>' +
        (state.resultB64 ? '<img class="tryonai-k-result" src="data:image/jpeg;base64,' + state.resultB64 + '" alt="Your outfit try-on">' : '<p class="tryonai-k-sub">No image returned.</p>');
      ui.foot.innerHTML =
        '<div class="tryonai-of-cta-row"><button type="button" class="tryonai-k-action" data-refine>Refine fit</button>' +
        '<button type="button" class="tryonai-k-action" data-back>Back to outfit</button>' +
        '<button type="button" class="tryonai-k-cta" data-addall><span>Add all to cart</span><span class="tryonai-k-cta__arrow">&rarr;</span></button></div>';
      ui.foot.querySelector("[data-refine]").addEventListener("click", function () { runTryOn("layered"); });
      ui.foot.querySelector("[data-back]").addEventListener("click", renderOutfit);
      ui.foot.querySelector("[data-addall]").addEventListener("click", addAll);
    }

    function addAll() {
      var pieces = (state.outfit && state.outfit.pieces) || [];
      var items = [], byVariant = {};
      pieces.forEach(function (p) {
        var n = parseInt(state.selected[p.handle] || p.variantId, 10);
        if (n > 0) { items.push({ id: n, quantity: 1, properties: { _tryonai_outfit: "1" } }); byVariant[String(n)] = p; }
      });
      if (!items.length) { ui.setError("These items are unavailable."); return; }
      var btn = ui.foot.querySelector("[data-addall]"); if (btn) btn.disabled = true;
      fetch("/cart/add.js", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json", "X-Requested-With": "XMLHttpRequest" }, body: JSON.stringify({ items: items }) })
        .then(function (res) {
          if (!res.ok) {
            return res.text().then(function (t) {
              var b = null; if (t) { try { b = JSON.parse(t); } catch (_) { /* non-JSON */ } }
              throw K.uiError((b && (b.description || b.message)) || "Add to cart failed.");
            });
          }
          return res.json();
        })
        .then(function (added) {
          (added && added.items ? added.items : []).forEach(function (it) { beacon(byVariant[String(it.variant_id || it.id)], it.variant_id || it.id, it); });
          ["tryonai:added-to-cart", "cart:refresh", "cart:updated", "cart:added"].forEach(function (n) { document.dispatchEvent(new CustomEvent(n)); });
          if (btn) btn.textContent = "Added ✓";
          setTimeout(ui.close, 900);
        })
        .catch(function (err) {
          if (btn) btn.disabled = false;
          if (!(err && err.tryonaiSafe)) console.warn("[tryonai] outfit add-to-cart error:", err);
          ui.setError(err && err.tryonaiSafe ? err.message : "Add to cart failed. Please try again.");
        });
    }

    function beacon(piece, variantId, item) {
      try {
        if (!state.reqId) return;
        var toInt = function (v) { var n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; };
        var currency = (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || null;
        fetch("/apps/tryonai/cart-event", {
          method: "POST", credentials: "same-origin", keepalive: true, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: state.reqId, productHandle: (piece && piece.handle) || null, variantId: variantId != null ? String(variantId) : null,
            quantity: (item && toInt(item.quantity)) || 1, priceCents: item ? toInt(item.price) : null,
            lineValueCents: item ? toInt(item.final_line_price != null ? item.final_line_price : item.line_price) : null, currency: currency }),
        }).catch(function () { /* noop */ });
      } catch (_) { /* noop */ }
    }

    function currentVariant(p) {
      var vid = state.selected[p.handle] || p.variantId;
      return (p.variants || []).find(function (v) { return String(v.id) === String(vid); }) || null;
    }
  }

  function slotLabel(slot) {
    var m = { top: "Top", bottom: "Bottom", dress: "Dress", outerwear: "Outerwear", shoes: "Shoes", accessory: "Accessory", other: "Piece" };
    return m[slot] || "Piece";
  }
  function tryonErr(code) {
    if (code === "rate_limited") return "Too many try-ons in a short time. Please wait a moment.";
    if (code === "trial_expired" || code === "cap_reached") return "Outfit try-on is temporarily unavailable for this store.";
    return "Outfit try-on failed. Please try again.";
  }
  function normImg(url) { if (!url) return null; return url.indexOf("//") === 0 ? "https:" + url : url; }
})();
