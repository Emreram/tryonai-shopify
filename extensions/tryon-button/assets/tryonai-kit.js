/* TryonAI Kit — shared behavior for the Outfit Stylist + Size Recommender.
 * Provides the portaled modal shell, the "journey" loading animation (the same
 * loom + glyph-swap + hairline bar + cross-fading status as the try-on), and the
 * shared helpers. Exposed as window.TryonaiKit. The try-on widget keeps its own
 * copy; this mirrors its look for the new surfaces. */
(function () {
  "use strict";
  if (window.TryonaiKit) return;

  var GLYPHS = {
    eye: '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>',
    pose: '<circle cx="12" cy="4.5" r="2.1"/><path d="M12 7v6.5M12 9l-4.3 2M12 9l4.3 2M12 13.5l-3 5.5M12 13.5l3 5.5"/>',
    fabric: '<path d="M4 5h16v14H4z"/><path d="M4 9c2.4 1.6 4.8 1.6 7.2 0S16 7.4 20 9M4 14c2.4 1.6 4.8 1.6 7.2 0S16 12.4 20 14"/>',
    fit: '<path d="M3 7l13.5-4 4 13.5-13.5 4z"/><path d="M8 6.4l1.1 3.3M11.6 5.3l1.1 3.3M15.2 9.4l1.1 3.3"/>',
    drape: '<path d="M3 8c2-2.4 4-2.4 6 0s4 2.4 6 0 4-2.4 6 0"/><path d="M3 14c2-2.4 4-2.4 6 0s4 2.4 6 0 4-2.4 6 0"/>',
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
    detail: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/><path d="M10.5 8v5M8 10.5h5"/>',
    finish: '<path d="M12 4l1.7 5L19 11l-5.3 1.4L12 18l-1.7-5.6L5 11l5.3-1z"/><path d="M18.5 15l.5 1.6 1.6.5-1.6.5-.5 1.6-.5-1.6-1.6-.5 1.6-.5z"/>',
    ruler: '<path d="M3 8h18v8H3z"/><path d="M7 8v3M11 8v4M15 8v3M19 8v4"/>',
    palette: '<path d="M12 3a9 9 0 100 18c1.5 0 2-1 2-2s-.5-1.5-.5-2.5.7-1.5 1.5-1.5H18a3 3 0 003-3c0-3.9-4-6-9-6z"/><circle cx="7.5" cy="11" r="1"/><circle cx="12" cy="8" r="1"/><circle cx="16.5" cy="11" r="1"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/>',
    check: '<path d="M4 12l5 5L20 6"/>',
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function money(v) {
    var n = Number(v) || 0;
    var code = (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || null;
    if (code) { try { return new Intl.NumberFormat(undefined, { style: "currency", currency: code }).format(n); } catch (_) { /* noop */ } }
    return n.toFixed(2);
  }

  function pickSizeFromRatio(w, h) {
    if (!w || !h) return "1024x1536";
    return w / h > 1.05 ? "1536x1024" : "1024x1536";
  }

  function upgradeShopifyImage(url) {
    if (!url) return url;
    if (!/cdn\.shopify\.com|shopifycdn\.com/.test(url)) return url;
    try {
      var u = new URL(url, window.location.origin);
      u.pathname = u.pathname.replace(/_(\d+)?x(\d+)?(?=\.[a-z]+($|\?))/i, "_1024x");
      if (u.searchParams.has("width")) u.searchParams.set("width", "1024");
      return u.toString();
    } catch (_) { return url; }
  }

  async function downsampleImage(file, maxEdge) {
    maxEdge = maxEdge || 1024;
    var bitmap;
    try { bitmap = await createImageBitmap(file); } catch (_) { throw new Error("decode failed"); }
    var w = bitmap.width, h = bitmap.height, longEdge = Math.max(w, h);
    if (longEdge <= maxEdge && file.type !== "image/png") { if (bitmap.close) bitmap.close(); return { file: file, width: w, height: h }; }
    var scale = longEdge > maxEdge ? maxEdge / longEdge : 1;
    var outW = Math.max(1, Math.round(w * scale)), outH = Math.max(1, Math.round(h * scale));
    var canvas = typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(outW, outH)
      : Object.assign(document.createElement("canvas"), { width: outW, height: outH });
    var ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, outW, outH);
    if (bitmap.close) bitmap.close();
    var blob = await (canvas.convertToBlob
      ? canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 })
      : new Promise(function (r) { canvas.toBlob(r, "image/jpeg", 0.9); }));
    if (!blob) throw new Error("encode failed");
    var base = (file.name || "image").replace(/\.[^.]+$/, "");
    return { file: new File([blob], base + ".jpg", { type: "image/jpeg" }), width: outW, height: outH };
  }

  function readSSE(res, onEvent) {
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = "";
    return (function pump() {
      return reader.read().then(function (r) {
        if (r.done) return;
        buf += decoder.decode(r.value, { stream: true });
        var nl;
        while ((nl = buf.indexOf("\n\n")) !== -1) {
          var frame = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          frame.split("\n").forEach(function (line) {
            if (!line.startsWith("data:")) return;
            var evt; try { evt = JSON.parse(line.slice(5).trim()); } catch (_) { return; }
            onEvent(evt);
          });
        }
        return pump();
      });
    })();
  }

  // Fetch + read a JSON body WITHOUT ever throwing a raw parse error to the
  // caller. Safari/WebKit surfaces a bare `res.json()` failure as the cryptic
  // "The string did not match the expected pattern." (Chrome: "Unexpected
  // token ..."), which must never reach a shopper. We read the body as text and
  // JSON.parse it inside a try/catch, so a non-JSON response — e.g. an app-proxy
  // "Bad Request"/HTML error page when a backend isn't deployed — resolves to
  // { data: null } instead of rejecting. Network failures resolve too.
  function fetchJson(url, opts) {
    return fetch(url, opts).then(
      function (res) {
        return res.text().then(
          function (text) {
            var data = null;
            if (text) { try { data = JSON.parse(text); } catch (_) { data = null; } }
            return { ok: res.ok, status: res.status, data: data };
          },
          function () { return { ok: res.ok, status: res.status, data: null }; }
        );
      },
      function () { return { ok: false, status: 0, data: null }; }
    );
  }

  // Tag a message as safe to show a shopper verbatim. Anything thrown that is NOT
  // a uiError (a raw DOMException, a parser error) is treated as internal and
  // shown as generic copy — so a native browser error can never reach the UI.
  function uiError(message) {
    var e = new Error(message);
    e.tryonaiSafe = true;
    return e;
  }

  // ---- modal shell ---------------------------------------------------------

  function createModal(opts) {
    opts = opts || {};
    var modal = document.createElement("div");
    modal.className = "tryonai-k-modal tryonai-kit";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.hidden = true;
    if (opts.theme) modal.setAttribute("data-theme", opts.theme);
    if (opts.shape) modal.setAttribute("data-button-shape", opts.shape);
    if (opts.accent) modal.style.setProperty("--tryonai-accent", opts.accent);
    modal.innerHTML =
      '<div class="tryonai-k-scrim" data-tk-close></div>' +
      '<div class="tryonai-k-panel" tabindex="-1">' +
      '  <div class="tryonai-k-topbar"><button type="button" class="tryonai-k-close" data-tk-close aria-label="Close">' +
      '    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"><path d="M5 5l14 14M19 5L5 19"/></svg>' +
      '  </button></div>' +
      '  <div class="tryonai-k-live" aria-live="polite"></div>' +
      '  <div class="tryonai-k-content"></div>' +
      '  <div class="tryonai-k-foot"></div>' +
      '</div>';
    document.body.appendChild(modal);

    var content = modal.querySelector(".tryonai-k-content");
    var foot = modal.querySelector(".tryonai-k-foot");
    var live = modal.querySelector(".tryonai-k-live");
    var panel = modal.querySelector(".tryonai-k-panel");
    var errorEl = null;
    var onClose = opts.onClose || function () {};

    function open() { modal.hidden = false; document.documentElement.style.overflow = "hidden"; panel.focus(); }
    function close() { modal.hidden = true; document.documentElement.style.overflow = ""; onClose(); }
    function setError(msg) {
      live.textContent = msg;
      if (!errorEl) { errorEl = document.createElement("div"); errorEl.className = "tryonai-k-error"; errorEl.setAttribute("role", "alert"); panel.appendChild(errorEl); }
      errorEl.textContent = msg; errorEl.hidden = false;
      setTimeout(function () { if (errorEl) errorEl.hidden = true; }, 5000);
    }
    function announce(msg) { live.textContent = msg; }

    modal.addEventListener("click", function (e) {
      if (e.target.closest("[data-tk-close]")) close();
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !modal.hidden) close(); });

    return { modal: modal, content: content, foot: foot, live: live, panel: panel, open: open, close: close, setError: setError, announce: announce };
  }

  // ---- journey loading -----------------------------------------------------

  function createJourney(mountEl, steps, opts) {
    opts = opts || {};
    steps = steps && steps.length ? steps : [{ glyph: "finish", label: "Working" }];
    var loomInner = opts.photoUrl
      ? '<img src="' + esc(opts.photoUrl) + '" alt="">'
      : '<div class="tryonai-k-loom__fill"></div>';
    mountEl.innerHTML =
      '<div class="tryonai-k-journey">' +
      '  <div class="tryonai-k-loom">' + loomInner +
      '    <span class="tryonai-k-loom__sweep"></span><span class="tryonai-k-loom__veil"></span></div>' +
      '  <div class="tryonai-k-progress">' +
      '    <span class="tryonai-k-glyph"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><g></g></svg></span>' +
      '    <div class="tryonai-k-track"><div class="tryonai-k-bar"></div></div>' +
      '  </div>' +
      '  <p class="tryonai-k-status"><span class="tryonai-k-status__layer is-current"></span><span class="tryonai-k-status__layer"></span></p>' +
      '</div>';

    var glyph = mountEl.querySelector(".tryonai-k-glyph");
    var glyphG = glyph.querySelector("g");
    var bar = mountEl.querySelector(".tryonai-k-bar");
    var progress = mountEl.querySelector(".tryonai-k-progress");
    var layers = mountEl.querySelectorAll(".tryonai-k-status__layer");
    var curLayer = 0;

    var cur = 0, target = 0, raf = 0, stopped = false, done = false;
    var n = steps.length;
    var CAP = 88;

    function setStep(i) {
      var step = steps[Math.min(i, n - 1)];
      glyphG.innerHTML = GLYPHS[step.glyph] || GLYPHS.finish;
      glyph.classList.remove("is-swapping"); void glyph.offsetWidth; glyph.classList.add("is-swapping");
      var incoming = layers[1 - curLayer], outgoing = layers[curLayer];
      incoming.textContent = step.label;
      incoming.classList.remove("is-leaving"); incoming.classList.add("is-current");
      outgoing.classList.remove("is-current"); outgoing.classList.add("is-leaving");
      curLayer = 1 - curLayer;
      target = Math.min(CAP, ((i + 1) / (n + 1)) * CAP + 6);
    }

    function tick() {
      if (stopped) return;
      cur += (target - cur) * 0.06;
      bar.style.width = cur.toFixed(2) + "%";
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    setStep(0);

    var stepIdx = 0;
    var timer = setInterval(function () {
      stepIdx++;
      if (stepIdx < n) {
        setStep(stepIdx);
      } else {
        clearInterval(timer);
        progress.classList.add("is-finishing");
        // gentle creep toward 98 while we await the real result
        var creep = setInterval(function () {
          if (stopped || done) { clearInterval(creep); return; }
          target = Math.min(98, target + (98 - target) * 0.15 + 0.2);
        }, 600);
      }
    }, opts.stepMs || 1500);

    return {
      nudge: function () { target = Math.min(CAP + 4, target + 3); },
      finish: function () {
        done = true; clearInterval(timer);
        target = 100;
        setTimeout(function () { stopped = true; cancelAnimationFrame(raf); bar.style.width = "100%"; }, 420);
      },
      destroy: function () { stopped = true; done = true; clearInterval(timer); cancelAnimationFrame(raf); },
    };
  }

  window.TryonaiKit = {
    GLYPHS: GLYPHS,
    esc: esc, money: money, pickSizeFromRatio: pickSizeFromRatio,
    upgradeShopifyImage: upgradeShopifyImage, downsampleImage: downsampleImage, readSSE: readSSE,
    fetchJson: fetchJson, uiError: uiError,
    createModal: createModal, createJourney: createJourney,
  };
})();
