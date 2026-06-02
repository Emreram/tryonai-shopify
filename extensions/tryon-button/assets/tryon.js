(function () {
  const SUPPORTED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
  const MAX_GARMENT_BYTES = 8 * 1024 * 1024;
  // A scripted, theatrical "journey" that plays for the WHOLE wait (the real
  // generation time can't be cut). Each step: `at` = ms from start, `to` =
  // target progress %, `icon` = glyph key, `label` = the big status line. The
  // last step `hold`s, then HANDS OFF to the creep (startCreep) so the bar keeps
  // inching toward CREEP_CAP and the label keeps rotating until the real result
  // lands — never a frozen bar. Copy describes process activity only — it never
  // claims the model detected/recognized/stored anything (consistent w/ consent).
  const JOURNEY = [
    { at: 0,     to: 7,  icon: "eye",    label: "Reading your photo" },
    { at: 3200,  to: 16, icon: "pose",   label: "Mapping your pose & proportions" },
    { at: 7000,  to: 26, icon: "fabric", label: "Studying the garment’s cut & weave" },
    { at: 11000, to: 36, icon: "fit",    label: "Tailoring it to your frame" },
    { at: 15000, to: 46, icon: "drape",  label: "Simulating drape & folds" },
    { at: 19000, to: 56, icon: "drape",  label: "Settling natural shadow" },
    { at: 22500, to: 65, icon: "light",  label: "Relighting to match your photo" },
    { at: 26000, to: 73, icon: "light",  label: "Balancing color & tone" },
    { at: 29500, to: 80, icon: "detail", label: "Refining fine detail" },
    { at: 33000, to: 86, icon: "detail", label: "Sharpening edges & seams" },
    { at: 36000, to: 90, icon: "finish", label: "Studio finish…", hold: true },
  ];
  // The scripted journey caps its bar at 90; once it reaches the terminal step
  // it hands off to a slow asymptotic "creep" toward CREEP_CAP so the bar is
  // never frozen during a long wait. Real-result handling (finishReveal) still
  // owns 100 exclusively — the creep never reaches it.
  const JOURNEY_HOLD_PCT = 90;
  const CREEP_CAP = 98;
  // Calm, process-only copy cycled during the creep so the last step never sits
  // on one unchanging line. Each carries the glyph it should show.
  const CREEP_LABELS = [
    { icon: "finish", label: "Studio finish…" },
    { icon: "light",  label: "Polishing highlights" },
    { icon: "detail", label: "Final color pass" },
    { icon: "finish", label: "Last refinements…" },
  ];

  // Stroke icons (24x24, currentColor) swapped into the glyph container per step.
  const GLYPHS = {
    eye:    '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>',
    pose:   '<circle cx="12" cy="4.5" r="2.1"/><path d="M12 7v6.5M12 9l-4.3 2M12 9l4.3 2M12 13.5l-3 5.5M12 13.5l3 5.5"/>',
    fabric: '<path d="M4 5h16v14H4z"/><path d="M4 9c2.4 1.6 4.8 1.6 7.2 0S16 7.4 20 9M4 14c2.4 1.6 4.8 1.6 7.2 0S16 12.4 20 14"/>',
    fit:    '<path d="M3 7l13.5-4 4 13.5-13.5 4z"/><path d="M8 6.4l1.1 3.3M11.6 5.3l1.1 3.3M15.2 9.4l1.1 3.3"/>',
    drape:  '<path d="M3 8c2-2.4 4-2.4 6 0s4 2.4 6 0 4-2.4 6 0"/><path d="M3 14c2-2.4 4-2.4 6 0s4 2.4 6 0 4-2.4 6 0"/>',
    light:  '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
    detail: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/><path d="M10.5 8v5M8 10.5h5"/>',
    finish: '<path d="M12 4l1.7 5L19 11l-5.3 1.4L12 18l-1.7-5.6L5 11l5.3-1z"/><path d="M18.5 15l.5 1.6 1.6.5-1.6.5-.5 1.6-.5-1.6-1.6-.5 1.6-.5z"/>',
  };

  function boot() {
    document.querySelectorAll(".tryonai-root").forEach(initRoot);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  function initRoot(root) {
    const productHandle = root.dataset.productHandle || "";
    const productTitle = root.dataset.productTitle || "";
    const fallbackVariantId = root.dataset.productVariantId || "";
    let cachedLiveVariantId = null;
    const initialHintedImageUrl = normalizeImageUrl(root.dataset.productImageUrl);

    const $ = (sel) => root.querySelector(sel);
    const launcher = $(".tryonai-launcher");
    const modal = $(".tryonai-modal");
    const panel = $(".tryonai-panel");
    const live = $(".tryonai-live");
    const fileInput = $(".tryonai-file-input");
    const garmentInput = $(".tryonai-garment-input");
    const selfieDrop = $(".tryonai-card--selfie .tryonai-drop");
    const selfiePreview = $(".tryonai-card--selfie .tryonai-drop__preview");
    const selfieClear = $(".tryonai-drop__clear");
    const itemBox = $(".tryonai-item");
    const itemImage = $(".tryonai-item__image");
    const itemTitle = $(".tryonai-item__title");
    const itemReplace = $(".tryonai-item__replace");
    const consent = $(".tryonai-consent-input");
    const cta = $(".tryonai-cta");
    const errorEl = $(".tryonai-error");
    const loomSelfie = $(".tryonai-loom__selfie");
    const loomGarment = $(".tryonai-loom__garment");
    const progressBar = $(".tryonai-progress__bar");
    const progressEl = $(".tryonai-progress");
    const loomEl = $(".tryonai-loom");
    const glyphEl = $(".tryonai-glyph");
    const glyphPathsEl = $(".tryonai-glyph__paths");
    const refineBar = $(".tryonai-refine-bar");
    const statusEl = $(".tryonai-status");
    const statusLayers = statusEl
      ? statusEl.querySelectorAll(".tryonai-status__layer")
      : [];
    const compare = $(".tryonai-compare");
    const compareBefore = $(".tryonai-compare__before");
    const compareAfter = $(".tryonai-compare__after");
    const slider = $(".tryonai-compare__slider");
    const addToCartBtn = root.querySelector('[data-action="add-to-cart"]');

    if (!launcher || !modal || !panel) {
      console.warn("[tryonai] missing required elements");
      return;
    }

    // Panel-level error banner. The inline ".tryonai-error" in the Liquid
    // template only exists inside the compose stage, so errors raised from
    // the reveal stage (e.g. add-to-cart failures) were previously invisible.
    // This banner lives on the panel itself and is shown on every stage.
    const panelErrorEl = document.createElement("div");
    panelErrorEl.className = "tryonai-panel-error";
    panelErrorEl.setAttribute("role", "alert");
    panelErrorEl.hidden = true;
    Object.assign(panelErrorEl.style, {
      position: "absolute",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      maxWidth: "calc(100% - 24px)",
      padding: "10px 14px",
      background: "#1a1a1a",
      color: "#fff",
      font: "500 13px/1.4 system-ui, -apple-system, sans-serif",
      borderRadius: "8px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
      zIndex: "10",
      textAlign: "center",
      pointerEvents: "none",
    });
    if (getComputedStyle(panel).position === "static") {
      panel.style.position = "relative";
    }
    panel.appendChild(panelErrorEl);

    // Portal the modal to <body> so it escapes any Shopify-theme containing
    // block. Themes commonly set transform/filter/contain on the product
    // section, which otherwise traps position:fixed and clips the overlay
    // to the column instead of the viewport.
    if (modal.parentElement !== document.body) {
      modal.classList.add("tryonai-root");
      const accent = root.style.getPropertyValue("--tryonai-accent");
      if (accent) modal.style.setProperty("--tryonai-accent", accent);
      modal.dataset.stage = root.dataset.stage || "idle";
      if (root.dataset.theme) modal.dataset.theme = root.dataset.theme;
      modal.dataset.tryonaiPortaled = "true";

      // Clean up stale portaled modals from prior section re-renders
      // (Shopify re-renders the section on variant change).
      document
        .querySelectorAll('body > .tryonai-modal[data-tryonai-portaled="true"]')
        .forEach((stale) => { if (stale !== modal) stale.remove(); });

      document.body.appendChild(modal);
    }

    const state = {
      selfieFile: null,
      uploadedGarment: null,
      detectedGarment: null,
      detectedGarmentUrl: null,
      resolution: null,
      generating: false,
      lastResult: null,
      lastResultBlob: null,
      progressRaf: null,
      progressTarget: 0,
      progressDisplayed: 0,
      journeyTimer: null,
      journeyStep: -1,
      journeyDone: false,
      creepTimer: null,
      lateLabelTimer: null,
      lateLabelIndex: 0,
      creeping: false,
      statusShiftTimer: null,
      glyphSwapTimer: null,
      abortController: null,
      resultFinalReady: false,
      lastFocus: null,
      scrollLockY: 0,
      scrollLockActive: false,
      hintedImageUrl: initialHintedImageUrl,
      requestId: null,
    };

    setStage("idle");

    launcher.addEventListener("click", openModal);

    // Click delegation lives on the modal (not root) because the modal is
    // portaled to <body> above — clicks inside it no longer bubble through
    // root. All data-action elements (close, scrim, clear-selfie,
    // replace-garment, generate, save, share, restart, add-to-cart) are
    // descendants of the modal.
    modal.addEventListener("click", (e) => {
      const actionEl = e.target.closest("[data-action]");
      if (!actionEl || !modal.contains(actionEl)) return;
      const action = actionEl.dataset.action;
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      switch (action) {
        case "dismiss":         closeModal(); break;
        case "clear-selfie":    clearSelfie(); break;
        case "replace-garment": revealGarmentUpload(); break;
        case "generate":        run(); break;
        case "save":            saveResult(); break;
        case "share":           shareResult(); break;
        case "restart":         restart(); break;
        case "add-to-cart":     addToCart(); break;
      }
    });

    // Mobile robustness: bind the dismiss affordances (✕ button + backdrop)
    // DIRECTLY, in addition to the modal-level click delegation above. On some
    // mobile browsers — notably iOS while the body scroll-lock is active — the
    // synthesized `click` that should bubble up to the modal listener is
    // dropped, so the ✕ appeared dead on phones. A direct listener that also
    // handles `touchend` closes reliably: touchend's preventDefault cancels the
    // would-be follow-up click and stopPropagation stops the delegation handler
    // from firing a second time, so there is no double-close.
    const bindDismiss = (el) => {
      if (!el) return;
      const onDismiss = (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeModal();
      };
      el.addEventListener("click", onDismiss);
      el.addEventListener("touchend", onDismiss, { passive: false });
    };
    bindDismiss(modal.querySelector(".tryonai-close"));
    bindDismiss(modal.querySelector(".tryonai-scrim"));

    fileInput.addEventListener("change", () => {
      state.selfieFile = fileInput.files?.[0] ?? null;
      updateSelfieUI();
      updateSubmit();
    });
    garmentInput.addEventListener("change", () => {
      state.uploadedGarment = garmentInput.files?.[0] ?? null;
      if (state.uploadedGarment) {
        const url = URL.createObjectURL(state.uploadedGarment);
        itemImage.src = url;
        itemBox.dataset.detected = "true";
        itemTitle.textContent = state.uploadedGarment.name;
        itemReplace.textContent = "Use a different photo →";
      }
      updateSubmit();
    });
    consent.addEventListener("change", updateSubmit);

    // Drag-and-drop niceties for selfie zone
    ["dragenter", "dragover"].forEach((ev) =>
      selfieDrop.addEventListener(ev, (e) => {
        e.preventDefault();
        selfieDrop.classList.add("is-dragover");
      }),
    );
    ["dragleave", "drop"].forEach((ev) =>
      selfieDrop.addEventListener(ev, (e) => {
        e.preventDefault();
        selfieDrop.classList.remove("is-dragover");
      }),
    );
    selfieDrop.addEventListener("drop", (e) => {
      const f = e.dataTransfer?.files?.[0];
      if (f && SUPPORTED_MIME.has(f.type)) {
        state.selfieFile = f;
        updateSelfieUI();
        updateSubmit();
      }
    });

    document.addEventListener("keydown", onKeydown);

    setupCompareCompare();
    observeCompareSize();

    if (compareAfter) {
      compareAfter.addEventListener("animationend", (e) => {
        if (e.animationName === "tryonai-mask-wipe") {
          compare.classList.remove("is-wiping");
        }
      });
    }

    function setupCompareCompare() {
      if (!compare) return;

      compare.setAttribute("role", "slider");
      compare.setAttribute("tabindex", "0");
      compare.setAttribute("aria-label", "Drag to compare before and after");
      compare.setAttribute("aria-valuemin", "0");
      compare.setAttribute("aria-valuemax", "100");
      compare.setAttribute("aria-valuenow", "50");

      let dragging = false;
      let pendingX = 0;
      let rafId = 0;

      const apply = () => {
        rafId = 0;
        const rect = compare.getBoundingClientRect();
        if (rect.width <= 0) return;
        const x = pendingX - rect.left;
        const pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
        const rounded = Math.round(pct);
        compare.style.setProperty("--tryonai-split", pct + "%");
        compare.setAttribute("aria-valuenow", String(rounded));
        compare.setAttribute(
          "aria-valuetext",
          rounded + "% before, " + (100 - rounded) + "% after"
        );
        if (slider) slider.value = String(100 - rounded);
      };

      const schedule = (clientX) => {
        pendingX = clientX;
        if (!rafId) rafId = requestAnimationFrame(apply);
      };

      const onDown = (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        dragging = true;
        compare.classList.remove("is-wiping");
        compare.classList.add("is-dragging");
        try {
          compare.setPointerCapture(e.pointerId);
        } catch (_) {
          // Pointer capture is best-effort; older embedded browsers can reject it.
        }
        schedule(e.clientX);
        e.preventDefault();
      };

      const onMove = (e) => {
        if (!dragging) return;
        schedule(e.clientX);
      };

      const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        compare.classList.remove("is-dragging");
        try {
          compare.releasePointerCapture(e.pointerId);
        } catch (_) {
          // Pointer capture is best-effort; it may already be released.
        }
      };

      compare.addEventListener("pointerdown", onDown);
      compare.addEventListener("pointermove", onMove);
      compare.addEventListener("pointerup", endDrag);
      compare.addEventListener("pointercancel", endDrag);

      compare.addEventListener("keydown", (e) => {
        const current =
          parseFloat(compare.style.getPropertyValue("--tryonai-split")) || 50;
        const step = e.shiftKey ? 10 : 2;
        let next = current;
        if (e.key === "ArrowLeft") next = current - step;
        else if (e.key === "ArrowRight") next = current + step;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = 100;
        else if (e.key === "PageDown") next = current - 10;
        else if (e.key === "PageUp") next = current + 10;
        else return;
        e.preventDefault();
        next = Math.max(0, Math.min(100, next));
        const rounded = Math.round(next);
        compare.style.setProperty("--tryonai-split", next + "%");
        compare.setAttribute("aria-valuenow", String(rounded));
        compare.setAttribute(
          "aria-valuetext",
          rounded + "% before, " + (100 - rounded) + "% after"
        );
        if (slider) slider.value = String(100 - rounded);
      });
    }

    let fitRafId = 0;
    function fitCompare() {
      if (!compare || !compareAfter) return;
      const w = compareAfter.naturalWidth;
      const h = compareAfter.naturalHeight;
      if (!w || !h) return;

      const stage = compare.closest(".tryonai-stage--reveal");
      if (!stage || stage.offsetParent === null) return;

      const stageRect = stage.getBoundingClientRect();
      const actions = stage.querySelector(".tryonai-actions");
      const gap = parseFloat(getComputedStyle(stage).rowGap) || 16;
      const actionsH = actions ? actions.offsetHeight : 0;

      const availW = Math.max(0, stageRect.width);
      const availH = Math.max(0, stageRect.height - actionsH - gap);
      if (availW === 0 || availH === 0) return;

      const aspect = w / h;
      let outW, outH;
      if (availW / aspect <= availH) {
        outW = availW;
        outH = availW / aspect;
      } else {
        outH = availH;
        outW = availH * aspect;
      }

      compare.style.setProperty(
        "--tryonai-compare-aspect",
        w + " / " + h
      );
      compare.style.width = outW + "px";
      compare.style.height = outH + "px";
    }

    function scheduleFit() {
      if (fitRafId) return;
      fitRafId = requestAnimationFrame(() => {
        fitRafId = 0;
        fitCompare();
      });
    }

    function observeCompareSize() {
      window.addEventListener("resize", scheduleFit, { passive: true });
      window.addEventListener("orientationchange", scheduleFit, { passive: true });
      if (typeof ResizeObserver !== "undefined") {
        const stage = compare?.closest(".tryonai-stage--reveal");
        if (stage) {
          const ro = new ResizeObserver(scheduleFit);
          ro.observe(stage);
        }
      }
    }

    function setStage(name) {
      root.dataset.stage = name;
      modal.dataset.stage = name;
      if (live && name !== "idle") {
        live.textContent =
          name === "compose" ? "Try-on opened. Add your photo." :
          name === "generating" ? "Creating your try-on. This takes up to a minute." :
          name === "reveal" ? "Your try-on is ready." : "";
      }
    }

    function openModal() {
      state.lastFocus = document.activeElement;
      modal.hidden = false;
      setStage("compose");
      lockBodyScroll();
      refreshGarmentHint();
      ensureResolution();
      requestAnimationFrame(() => {
        panel.focus();
        const composeStage = modal.querySelector(".tryonai-stage--compose");
        if (composeStage) composeStage.scrollTop = 0;
      });
    }

    function refreshGarmentHint() {
      const fresh = findCurrentGalleryImage(launcher);
      if (!fresh) return;
      if (fresh === state.hintedImageUrl && state.resolution) return;
      state.hintedImageUrl = fresh;
      // Bust caches so the new image actually loads
      state.resolution = null;
      state.detectedGarment = null;
      state.detectedGarmentUrl = null;
      state.uploadedGarment = null;
      itemBox.dataset.detected = "false";
      itemImage.removeAttribute("src");
      itemTitle.textContent = "";
    }

    function closeModal() {
      if (state.generating) {
        if (!confirm("Cancel the try-on?")) return;
        state.generating = false;
        if (state.abortController) {
          try {
            state.abortController.abort();
          } catch (_) {
            // Abort is best-effort; the request may already be settled.
          }
          state.abortController = null;
        }
      }
      stopProgress();
      modal.hidden = true;
      setStage("idle");
      unlockBodyScroll();
      if (state.lastFocus && typeof state.lastFocus.focus === "function") {
        try {
          state.lastFocus.focus();
        } catch (_) {
          // Restoring focus is best-effort after the modal closes.
        }
      }
    }

    function lockBodyScroll() {
      if (state.scrollLockActive) return;
      state.scrollLockActive = true;
      state.scrollLockY = window.scrollY || window.pageYOffset || 0;
      const body = document.body;
      const html = document.documentElement;
      // Preserve scrollbar width to avoid layout jump
      const scrollbarWidth = window.innerWidth - html.clientWidth;
      body.dataset.tryonaiPrevPosition = body.style.position || "";
      body.dataset.tryonaiPrevTop = body.style.top || "";
      body.dataset.tryonaiPrevLeft = body.style.left || "";
      body.dataset.tryonaiPrevRight = body.style.right || "";
      body.dataset.tryonaiPrevWidth = body.style.width || "";
      body.dataset.tryonaiPrevOverflow = body.style.overflow || "";
      body.dataset.tryonaiPrevPaddingRight = body.style.paddingRight || "";
      body.style.position = "fixed";
      body.style.top = `-${state.scrollLockY}px`;
      body.style.left = "0";
      body.style.right = "0";
      body.style.width = "100%";
      body.style.overflow = "hidden";
      if (scrollbarWidth > 0) {
        body.style.paddingRight = `${scrollbarWidth}px`;
      }
    }

    function unlockBodyScroll() {
      if (!state.scrollLockActive) return;
      state.scrollLockActive = false;
      const body = document.body;
      body.style.position = body.dataset.tryonaiPrevPosition || "";
      body.style.top = body.dataset.tryonaiPrevTop || "";
      body.style.left = body.dataset.tryonaiPrevLeft || "";
      body.style.right = body.dataset.tryonaiPrevRight || "";
      body.style.width = body.dataset.tryonaiPrevWidth || "";
      body.style.overflow = body.dataset.tryonaiPrevOverflow || "";
      body.style.paddingRight = body.dataset.tryonaiPrevPaddingRight || "";
      delete body.dataset.tryonaiPrevPosition;
      delete body.dataset.tryonaiPrevTop;
      delete body.dataset.tryonaiPrevLeft;
      delete body.dataset.tryonaiPrevRight;
      delete body.dataset.tryonaiPrevWidth;
      delete body.dataset.tryonaiPrevOverflow;
      delete body.dataset.tryonaiPrevPaddingRight;
      window.scrollTo(0, state.scrollLockY);
    }

    function onKeydown(e) {
      if (modal.hidden) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeModal();
      } else if (e.key === "Tab") {
        trapFocus(e);
      }
    }

    function trapFocus(e) {
      const focusables = panel.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    function updateSelfieUI() {
      if (state.selfieFile) {
        selfiePreview.src = URL.createObjectURL(state.selfieFile);
        selfiePreview.hidden = false;
        selfieDrop.classList.add("is-filled");
        selfieClear.hidden = false;
      } else {
        selfiePreview.hidden = true;
        selfieDrop.classList.remove("is-filled");
        selfieClear.hidden = true;
        fileInput.value = "";
      }
    }

    function clearSelfie() {
      state.selfieFile = null;
      updateSelfieUI();
      updateSubmit();
    }

    function revealGarmentUpload() {
      garmentInput.click();
    }

    function showManualGarment(placeholderTitle) {
      itemBox.dataset.detected = "false";
      itemBox.hidden = false;
      itemImage.removeAttribute("src");
      itemTitle.textContent = placeholderTitle || "No item photo";
      itemReplace.textContent = "Upload a photo →";
    }
    function showDetectedGarment(file) {
      state.detectedGarment = file;
      state.detectedGarmentUrl =
        (file && typeof file.tryonaiSourceUrl === "string" && file.tryonaiSourceUrl) || null;
      itemImage.src = URL.createObjectURL(file);
      itemTitle.textContent = productTitle || "Detected item";
      itemBox.dataset.detected = "true";
      itemBox.hidden = false;
      itemReplace.textContent = "Use a different photo →";
    }

    function activeGarment() {
      return state.uploadedGarment || state.detectedGarment;
    }

    function updateSubmit() {
      cta.disabled = !(state.selfieFile && consent.checked && activeGarment());
    }

    function ensureResolution() {
      if (state.resolution) return state.resolution;
      itemBox.hidden = false;
      itemBox.dataset.detected = "false";
      state.resolution = resolveProductGarment({ productHandle, hintedImageUrl: state.hintedImageUrl })
        .then((file) => {
          if (!file) { showManualGarment("Upload an item photo"); return; }
          showDetectedGarment(file);
          updateSubmit();
        })
        .catch((err) => {
          console.warn("[tryonai] resolution failed", err);
          showManualGarment("Upload an item photo");
        });
      return state.resolution;
    }

    async function run() {
      const garmentFile = activeGarment();
      if (!state.selfieFile || !garmentFile) return;

      const t = {
        click: performance.now(),
        downsampleDone: null,
        fetchSent: null,
        firstByte: null,
        firstPartial: null,
        preview: null,
        completed: null,
        rendered: null,
      };
      let serverTiming = null;
      const originalSelfieBytes = state.selfieFile.size;
      const originalGarmentBytes = garmentFile.size;

      hideError();
      state.generating = true;
      state.resultFinalReady = false;
      setStage("generating");
      startGeneratingAnimation(state.selfieFile, garmentFile);

      let selfieForUpload, garmentForUpload, selfieW = 0, selfieH = 0;
      try {
        // Always downsample selfie (user-uploaded). Only downsample garment when
        // the user uploaded it directly — Shopify-CDN garments are already 1024w
        // via upgradeShopifyImage().
        const [selfieOut, garmentOut] = await Promise.all([
          downsampleImage(state.selfieFile),
          state.uploadedGarment
            ? downsampleImage(garmentFile)
            : Promise.resolve({ file: garmentFile, width: 0, height: 0 }),
        ]);
        selfieForUpload = selfieOut.file;
        selfieW = selfieOut.width;
        selfieH = selfieOut.height;
        garmentForUpload = garmentOut.file;
      } catch (err) {
        stopProgress();
        state.generating = false;
        setStage("compose");
        showError("Could not read the photo. Try a different image.");
        return;
      }

      t.downsampleDone = performance.now();
      const size = pickSizeFromRatio(selfieW, selfieH);

      const fd = new FormData();
      fd.append("selfie", selfieForUpload);
      fd.append("garment", garmentForUpload, garmentForUpload.name || "garment.jpg");
      fd.append("size", size);
      if (productHandle) fd.append("product_handle", productHandle);
      // Stable garment identity for the server-side result cache: when the
      // garment is CDN-derived (NOT user-uploaded), send the canonical CDN URL
      // the blob was fetched from so the cache can key on a stable URL instead
      // of unstable bytes. User-uploaded garments send nothing — the server
      // falls back to hashing the bytes. Guarded so a missing URL never throws.
      if (!state.uploadedGarment) {
        const garmentUrl = state.detectedGarmentUrl;
        if (typeof garmentUrl === "string" && garmentUrl) {
          fd.append("garment_url", garmentUrl);
        }
      }

      const controller = new AbortController();
      state.abortController = controller;

      // Absolute backstop so the UI can NEVER stay pinned on the generating stage:
      // if neither a `completed` nor an `error` frame arrives within this ceiling
      // (well above the ~120s server-side OpenAI timeout), the stream is stuck —
      // e.g. an idle-but-open connection that never EOFs. Abort and recover. The
      // flag lets the catch tell this apart from a user-initiated cancel.
      let watchdogTimedOut = false;
      const watchdog = window.setTimeout(() => {
        watchdogTimedOut = true;
        try { controller.abort(); } catch (_) { /* already settled */ }
      }, 180000);

      // The scripted journey owns the entire generating UI; real preview/partial
      // frames are NOT revealed early — we unveil only on `completed`. We still
      // stash the latest bytes so the post-loop guard + timing log keep working.
      let lastB64 = null;

      state.requestId = null;
      try {
        t.fetchSent = performance.now();
        // Storefront calls the app via the Shopify App Proxy mounted at
        // /apps/tryonai. The proxy injects shop + HMAC signature on every
        // request — we no longer need (or want) a cross-origin call to the
        // app server directly.
        const res = await fetch("/apps/tryonai/tryon", {
          method: "POST",
          body: fd,
          signal: controller.signal,
          credentials: "same-origin",
          headers: { Accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) {
          let errMsg = "Generation failed";
          let errCode = null;
          let retryAfterSec = null;
          try {
            const j = await res.json();
            errCode = j.error || null;
            errMsg = j.error || errMsg;
            if (typeof j.retryAfter === "number") retryAfterSec = j.retryAfter;
          } catch (_) { /* not JSON, keep default */ }
          // Branch on the explicit error code, NOT the HTTP status: both
          // `rate_limited` and `cap_reached` are returned as 429, so a
          // status-only check mislabels a hit monthly cap as a short throttle.
          if (errCode === "rate_limited") {
            const header = res.headers.get("Retry-After");
            if (retryAfterSec === null && header) {
              const parsed = parseInt(header, 10);
              if (Number.isFinite(parsed) && parsed > 0) retryAfterSec = parsed;
            }
            const waitHint =
              retryAfterSec && retryAfterSec >= 60
                ? `${Math.ceil(retryAfterSec / 60)} minutes`
                : retryAfterSec
                  ? `${retryAfterSec} seconds`
                  : "a few minutes";
            throw new Error(
              `Too many try-ons in a short time. Please wait ${waitHint} and try again.`,
            );
          }
          // Store-level limits the shopper can't resolve (the merchant's free
          // trial is used up, or the plan's monthly allowance is reached).
          // Show a graceful message instead of leaking the raw error token.
          if (errCode === "trial_expired" || errCode === "cap_reached") {
            throw new Error(
              "Virtual try-on is temporarily unavailable for this store. Please check back soon.",
            );
          }
          throw new Error(errMsg);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let streaming = true;

        while (streaming) {
          const { value, done } = await reader.read();
          if (done) { streaming = false; break; }
          if (t.firstByte === null) t.firstByte = performance.now();
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              let evt;
              try {
                evt = JSON.parse(line.slice(5).trim());
              } catch (_) { continue; }
              if (evt.kind === "meta") {
                if (typeof evt.requestId === "string") {
                  state.requestId = evt.requestId;
                }
                continue;
              }
              if (evt.kind === "partial") {
                if (t.firstPartial === null) t.firstPartial = performance.now();
                lastB64 = evt.b64; // stash only — single unveil owns the pixels
                nudgeFromRealSignal("partial", evt.index || 0); // use timing only
              } else if (evt.kind === "preview") {
                if (t.preview === null) t.preview = performance.now();
                lastB64 = evt.b64; // stash only — no early reveal
                nudgeFromRealSignal("preview"); // use timing only
              } else if (evt.kind === "completed") {
                t.completed = performance.now();
                lastB64 = evt.b64;
                // The single unveil: end the journey, then wipe in the FINAL.
                await unveilFinal(evt.b64);
                t.rendered = performance.now();
              } else if (evt.kind === "timing") {
                serverTiming = evt;
              } else if (evt.kind === "error") {
                const e = new Error(evt.error || "Generation failed");
                if (evt.code) e.code = evt.code;
                throw e;
              }
            }
          }
        }

        if (!lastB64) throw new Error("No image returned");

        // Safety net for the single-unveil design (the reveal above runs ONLY in
        // the `completed` branch): if the stream ENDED after a preview/partial
        // stashed `lastB64` but no terminal `completed` frame was ever processed
        // — a dropped connection or App-Proxy idle-timeout mid-generation, or a
        // `completed` frame that failed to JSON.parse and got silently skipped —
        // finishReveal() would otherwise never run and the widget would sit on the
        // generating stage forever (bar pinned near the creep cap). Unveil the best
        // image we actually received. `t.completed` is set ONLY by the completed
        // branch, so the normal success path skips this and never double-reveals.
        if (t.completed === null) {
          await unveilFinal(lastB64);
          t.rendered = performance.now();
        }

        const delta = (a, b) =>
          a === null || b === null ? null : Math.round(a - b);
        const log = {
          event: "tryon_client_complete",
          size,
          selfie_kb: Math.round(selfieForUpload.size / 1024),
          garment_kb: Math.round(garmentForUpload.size / 1024),
          original_selfie_kb: Math.round(originalSelfieBytes / 1024),
          original_garment_kb: Math.round(originalGarmentBytes / 1024),
          uploaded_garment: !!state.uploadedGarment,
          timings_ms: {
            click_to_downsample: delta(t.downsampleDone, t.click),
            downsample_to_fetch: delta(t.fetchSent, t.downsampleDone),
            fetch_to_first_byte: delta(t.firstByte, t.fetchSent),
            first_byte_to_first_partial: delta(t.firstPartial, t.firstByte),
            first_byte_to_preview: delta(t.preview, t.firstByte),
            preview_to_completed: delta(t.completed, t.preview),
            first_byte_to_completed: delta(t.completed, t.firstByte),
            completed_to_rendered: delta(t.rendered, t.completed),
            total_client: delta(t.rendered ?? t.completed, t.click),
          },
          server: serverTiming,
        };
        // eslint-disable-next-line no-console
        console.log("[tryonai]", JSON.stringify(log));
      } catch (err) {
        if (err && err.name === "AbortError") {
          // A watchdog timeout reaches here too (it aborts the controller). Unlike
          // a user cancel, it must not leave the widget spinning: reveal the best
          // image we received, or surface a friendly timeout if we got nothing.
          if (watchdogTimedOut && t.completed === null) {
            if (lastB64) {
              try {
                await unveilFinal(lastB64);
                return;
              } catch (_) { /* fall through to the error message below */ }
            }
            stopProgress();
            state.generating = false;
            setStage("compose");
            showError("This try-on took too long. Please try again.");
            return;
          }
          stopProgress();
          return;
        }
        stopProgress();
        state.generating = false;
        setStage("compose");
        showError((err && err.message) || "Generation failed", err && err.code);
      } finally {
        window.clearTimeout(watchdog);
        state.abortController = null;
      }
    }

    function setProgress(pct) {
      // Terminal/direct write. During the journey the rAF loop (below) owns the
      // width; this is used by finishReveal(100) after the rAF is cancelled.
      state.progressTarget = pct;
      state.progressDisplayed = pct;
      progressBar.style.width = pct + "%";
      if (refineBar) refineBar.style.width = pct + "%";
    }

    // --- Scripted journey driver --------------------------------------------

    // Swap the per-step icon into the single glyph container, with a pop + draw.
    function setGlyph(key) {
      const markup = GLYPHS[key];
      if (!glyphEl || !glyphPathsEl || !markup) return;
      if (!glyphPathsEl.firstChild) {
        glyphPathsEl.innerHTML = markup; // first paint: no animation
        return;
      }
      glyphEl.classList.remove("is-swapping");
      void glyphEl.offsetWidth; // reflow so consecutive swaps re-trigger
      glyphEl.classList.add("is-swapping");
      clearTimeout(state.glyphSwapTimer);
      state.glyphSwapTimer = window.setTimeout(() => {
        glyphPathsEl.innerHTML = markup;
      }, 250); // swap at the dissolve trough (~45% of 560ms)
    }

    // Overlapping cross-fade of the big status line via two stacked layers:
    // the incoming layer rises + sharpens (blur->0) while the outgoing drifts up
    // + softens, both transitioning together — no blank frame between steps.
    function setStatusLabel(text) {
      if (!statusEl || !text || statusLayers.length < 2) return;
      const current =
        statusEl.querySelector(".tryonai-status__layer.is-current") ||
        statusLayers[0];
      if (current.textContent === text) return;
      const incoming =
        current === statusLayers[0] ? statusLayers[1] : statusLayers[0];
      incoming.textContent = text;
      incoming.classList.remove("is-current", "is-leaving");
      void incoming.offsetWidth; // commit the below/blurred/transparent start state
      incoming.classList.add("is-current");
      current.classList.remove("is-current");
      current.classList.add("is-leaving");
      announce(text); // one SR announcement per real step change
    }

    // A single rAF loop eases the bar toward state.progressTarget, so it always
    // drifts forward and decelerates near each target — never static, and it
    // asymptotes at the hold cap (never reaching 100 on its own).
    function startProgressLoop() {
      const reduce =
        !!window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      let last = performance.now();
      const tick = (now) => {
        const dt = Math.min(64, now - last) / 1000; // clamp for tab throttling
        last = now;
        const target = state.progressTarget;
        if (reduce) {
          state.progressDisplayed = target;
        } else {
          const d = state.progressDisplayed;
          const next = d + (target - d) * Math.min(1, 2.0 * dt); // silkier glide
          state.progressDisplayed =
            Math.abs(target - next) < 0.12 ? target : next;
        }
        const w = state.progressDisplayed.toFixed(2) + "%";
        progressBar.style.width = w;
        if (refineBar) refineBar.style.width = w;
        state.progressRaf = requestAnimationFrame(tick);
      };
      state.progressRaf = requestAnimationFrame(tick);
    }

    function setProgressTarget(pct) {
      // Monotonic + capped below 100 (only finishReveal writes 100). The cap is
      // CREEP_CAP so the creep phase can inch past the journey's 90 ceiling;
      // scripted/nudge inputs are all <= JOURNEY_HOLD_PCT, so they self-limit.
      state.progressTarget = Math.max(
        state.progressTarget || 0,
        Math.min(CREEP_CAP, pct),
      );
    }

    function applyJourneyStep(i) {
      if (i <= state.journeyStep) return; // forward-only
      state.journeyStep = i;
      const step = JOURNEY[i];
      setProgressTarget(step.to);
      if (i === 0) {
        // First paint: place the label + glyph instantly (no shift/pop). Reset
        // the two status layers so a re-run starts clean.
        if (statusLayers.length) {
          statusLayers[0].textContent = step.label;
          statusLayers[0].classList.add("is-current");
          if (statusLayers[1]) {
            statusLayers[1].classList.remove("is-current", "is-leaving");
            statusLayers[1].textContent = "";
          }
        }
        setGlyph(step.icon);
        announce(step.label);
      } else {
        setStatusLabel(step.label);
        setGlyph(step.icon);
      }
      if (loomEl) {
        loomEl.classList.remove("is-pulsing");
        void loomEl.offsetWidth;
        loomEl.classList.add("is-pulsing");
      }
    }

    // Largest scripted step whose target is still <= floor — used to keep the
    // label in sync with the bar when a real signal races us ahead.
    function journeyStepForFloor(floor) {
      let idx = 0;
      for (let i = 0; i < JOURNEY.length; i++) {
        if (JOURNEY[i].to <= floor) idx = i;
      }
      return idx;
    }

    // A real backend event (preview / partial) means the model is genuinely far
    // along — pull the bar forward to a matching FLOOR (forward-only, no pixels
    // shown) so a fast generation stops crawling the scripted timeline. The
    // scripted journey is the floor; this is the accelerator; creep is the net.
    function nudgeFromRealSignal(kind, index) {
      if (state.journeyDone) return;
      let floor;
      if (kind === "preview") {
        floor = 88; // a complete (low-res) image exists — we're close
      } else if (kind === "partial") {
        floor = index >= 2 ? 88 : index === 1 ? 84 : 78;
      } else {
        return;
      }
      const stepIdx = journeyStepForFloor(floor);
      if (stepIdx > state.journeyStep) applyJourneyStep(stepIdx);
      setProgressTarget(floor);
      // Preview = essentially done generating; enter the calm creep early so the
      // bar/label keep moving through the final stretch.
      if (kind === "preview") startCreep();
    }

    function advanceJourney() {
      state.journeyTimer = null;
      if (state.journeyDone || state.creeping) return; // creep owns the UI now
      const next = state.journeyStep + 1;
      if (next >= JOURNEY.length) return;
      applyJourneyStep(next);
      const step = JOURNEY[next];
      if (step.hold) {
        // Terminal scripted step reached: hand off to the creep so the bar keeps
        // inching forward (and the label keeps rotating) until `completed`.
        startCreep();
        return;
      }
      const followon = JOURNEY[next + 1];
      if (followon) {
        state.journeyTimer = window.setTimeout(
          advanceJourney,
          followon.at - step.at,
        );
      }
    }

    function startJourney() {
      if (state.journeyTimer) clearTimeout(state.journeyTimer);
      state.journeyTimer = null;
      state.journeyDone = false;
      state.journeyStep = -1;
      applyJourneyStep(0);
      const second = JOURNEY[1];
      if (second) {
        state.journeyTimer = window.setTimeout(
          advanceJourney,
          second.at - JOURNEY[0].at,
        );
      }
    }

    // The wait outran the scripted journey: keep the bar alive instead of
    // freezing at the hold cap. A slow timer raises progressTarget toward
    // CREEP_CAP along a DECELERATING curve (each tick closes a fraction of the
    // remaining gap), so the bar always inches forward yet visibly slows the
    // longer it waits — honest about "almost done, not done". In parallel a
    // label cycle keeps the status line + glyph changing. Idempotent.
    function startCreep() {
      if (state.creeping || state.journeyDone) return;
      state.creeping = true;
      // Cancel any pending scripted advance + pin to terminal so a late timer
      // can't flip the label back under the creep's rotation.
      if (state.journeyTimer) clearTimeout(state.journeyTimer);
      state.journeyTimer = null;
      state.journeyStep = JOURNEY.length - 1;
      if (progressEl) progressEl.classList.add("is-finishing");

      const reduce =
        !!window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      const creepTick = () => {
        const t = state.progressTarget;
        if (t < CREEP_CAP - 0.1) setProgressTarget(t + (CREEP_CAP - t) * 0.06);
        state.creepTimer = window.setTimeout(creepTick, 600);
      };
      state.creepTimer = window.setTimeout(creepTick, 600);

      // Rotate the calm finish copy; first entry already on screen from the
      // terminal step, so begin at the next one. Hold on the last label.
      state.lateLabelIndex = 0;
      const rotate = () => {
        state.lateLabelIndex += 1;
        const entry = CREEP_LABELS[
          Math.min(state.lateLabelIndex, CREEP_LABELS.length - 1)
        ];
        setStatusLabel(entry.label);
        setGlyph(entry.icon);
        if (loomEl) {
          loomEl.classList.remove("is-pulsing");
          void loomEl.offsetWidth;
          loomEl.classList.add("is-pulsing");
        }
        if (state.lateLabelIndex < CREEP_LABELS.length - 1) {
          state.lateLabelTimer = window.setTimeout(rotate, reduce ? 5200 : 3500);
        }
      };
      state.lateLabelTimer = window.setTimeout(rotate, reduce ? 5200 : 3500);
    }

    function stopCreep() {
      if (state.creepTimer) clearTimeout(state.creepTimer);
      if (state.lateLabelTimer) clearTimeout(state.lateLabelTimer);
      state.creepTimer = null;
      state.lateLabelTimer = null;
      state.creeping = false;
      if (progressEl) progressEl.classList.remove("is-finishing");
    }

    // Completion arrived: run the rest of the script instantly so the reveal
    // never looks cut off mid-step. Fills to the hold cap — finishReveal owns 100.
    function fastForwardJourney() {
      if (state.journeyTimer) clearTimeout(state.journeyTimer);
      state.journeyTimer = null;
      stopCreep();
      state.journeyDone = true;
      state.journeyStep = JOURNEY.length - 1;
      setProgressTarget(JOURNEY_HOLD_PCT);
    }

    function startGeneratingAnimation(selfie, garment) {
      loomSelfie.src = URL.createObjectURL(selfie);
      loomGarment.src = URL.createObjectURL(garment);

      // Reset progress + journey for a clean (re-)run.
      state.progressTarget = 0;
      state.progressDisplayed = 0;
      progressBar.style.width = "0%";
      if (refineBar) {
        refineBar.classList.remove("is-complete");
        refineBar.style.width = "0%";
      }
      compare.classList.remove("is-developing");
      delete compare.dataset.refine;
      stopCreep();

      startProgressLoop();
      startJourney();
    }

    function stopProgress() {
      if (state.progressRaf) cancelAnimationFrame(state.progressRaf);
      if (state.journeyTimer) clearTimeout(state.journeyTimer);
      if (state.statusShiftTimer) clearTimeout(state.statusShiftTimer);
      if (state.glyphSwapTimer) clearTimeout(state.glyphSwapTimer);
      stopCreep();
      state.progressRaf = null;
      state.journeyTimer = null;
    }

    function enterRevealFromB64(b64, selfie) {
      const dataUrl = "data:image/jpeg;base64," + b64;
      state.lastResult = dataUrl;
      state.lastResultBlob = null;
      state.resultFinalReady = false;

      compareBefore.src = URL.createObjectURL(selfie);
      compareAfter.src = dataUrl;
      compare.classList.remove("is-revealed");
      compare.classList.remove("is-wiping");
      compare.style.setProperty("--tryonai-split", "50%");
      compare.setAttribute("aria-valuenow", "50");
      compare.style.visibility = "hidden";
      if (slider) slider.value = 50;

      setStage("reveal");
      requestAnimationFrame(() => {
        fitCompare();
        compare.style.visibility = "";
        requestAnimationFrame(() => {
          compare.classList.add("is-revealed");
          compare.classList.add("is-wiping");
        });
      });
    }

    // The single unveil: fast-forward the scripted journey, swap in the image,
    // then finish (writes 100%, clears the generating state, reveals). Shared by
    // the `completed` frame and by the stream-ended / watchdog fallbacks so the
    // widget ALWAYS reaches a terminal revealed state instead of hanging.
    async function unveilFinal(b64) {
      fastForwardJourney();
      enterRevealFromB64(b64, state.selfieFile);
      await finishReveal(b64);
    }

    async function finishReveal(b64) {
      state.journeyDone = true; // defensive: short-circuit any late journey tick
      const dataUrl = "data:image/jpeg;base64," + b64;
      state.lastResult = dataUrl;
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        state.lastResultBlob = new Blob([bytes], { type: "image/jpeg" });
      } catch (_) {
        state.lastResultBlob = null;
      }
      state.resultFinalReady = true;
      hideError();

      setProgress(100);
      compareAfter.src = dataUrl;
      try {
        await compareAfter.decode?.();
      } catch (_) {
        // decode() rejects on broken images; let the <img> handler surface it.
      }

      stopProgress();
      state.generating = false;

      // The final crisp image is in place — drop the develop blur + refine bar
      // so nothing stays softened, and announce real completion for SR users
      // (the reveal-stage announcement was softened to "appearing, refining").
      compare.classList.remove("is-developing");
      delete compare.dataset.refine;
      if (refineBar) refineBar.classList.add("is-complete");
      announce("Your try-on is ready.");

      requestAnimationFrame(() => { fitCompare(); });
    }

    async function saveResult() {
      if (!state.lastResult) return;
      if (!state.resultFinalReady) {
        showError("Your final image is still finishing.");
        return;
      }
      const a = document.createElement("a");
      a.href = state.lastResult;
      a.download = `try-on-${productHandle || "result"}.jpg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    async function shareResult() {
      if (!state.resultFinalReady) {
        showError("Your final image is still finishing.");
        return;
      }
      if (!state.lastResultBlob) return saveResult();
      const file = new File([state.lastResultBlob], "try-on.jpg", { type: "image/jpeg" });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: productTitle || "Try-on" });
          return;
        } catch (_) { /* user cancelled */ }
      }
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/jpeg": state.lastResultBlob })]);
        announce("Image copied to clipboard.");
      } catch (_) {
        saveResult();
      }
    }

    function restart() {
      setStage("compose");
      compare.classList.remove("is-revealed");
      compare.classList.remove("is-wiping");
      hideError();
    }

    function asPositiveInt(v) {
      const n = Number(v);
      return Number.isInteger(n) && n > 0 ? n : null;
    }

    async function resolveCurrentVariantId() {
      try {
        const fromUrl = asPositiveInt(
          new URLSearchParams(window.location.search).get("variant")
        );
        if (fromUrl) return fromUrl;
      } catch (_) { /* noop */ }

      const formInput = document.querySelector(
        'form[action*="/cart/add"] [name="id"]'
      );
      const fromForm = asPositiveInt(formInput?.value);
      if (fromForm) return fromForm;

      const selectedRadio = document.querySelector('input[name="id"]:checked');
      const fromRadio = asPositiveInt(selectedRadio?.value);
      if (fromRadio) return fromRadio;

      const selectEl = document.querySelector('select[name="id"]');
      const fromSelect = asPositiveInt(selectEl?.value);
      if (fromSelect) return fromSelect;

      const fromData = asPositiveInt(fallbackVariantId);
      if (fromData) return fromData;

      if (cachedLiveVariantId) return cachedLiveVariantId;
      if (productHandle && /^[a-z0-9][a-z0-9-]*$/i.test(productHandle)) {
        try {
          const res = await fetch(
            `/products/${encodeURIComponent(productHandle)}.js`,
            {
              headers: { Accept: "application/json" },
              credentials: "same-origin",
            }
          );
          if (res.ok) {
            const product = await res.json();
            const variants = Array.isArray(product?.variants) ? product.variants : [];
            const firstAvailable = variants.find((v) => v && v.available);
            const candidate =
              asPositiveInt(firstAvailable?.id) || asPositiveInt(variants[0]?.id);
            if (candidate) {
              cachedLiveVariantId = candidate;
              return candidate;
            }
          }
        } catch (_) { /* noop */ }
      }

      return null;
    }

    async function addToCart() {
      addToCartBtn.disabled = true;
      try {
        const variantId = await resolveCurrentVariantId();
        if (!variantId) {
          showError("This item is unavailable.");
          return;
        }

        const res = await fetch("/cart/add.js", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: JSON.stringify({
            items: [
              {
                id: variantId,
                quantity: 1,
                properties: { _tryonai: "1" },
              },
            ],
          }),
        });
        if (!res.ok) {
          let message = "Add to cart failed";
          try {
            const body = await res.json();
            message = body?.description || body?.message || message;
          } catch (_) { /* keep default */ }
          throw new Error(message);
        }

        // Read the added line item(s) so the tracking beacon can attribute the
        // cart value. Parsing failures are swallowed — the add-to-cart already
        // succeeded and must never be blocked or undone by tracking.
        let addedBody = null;
        try {
          addedBody = await res.json();
        } catch (_) {
          /* not JSON / already consumed — beacon still records the count */
        }
        reportCartAdd(variantId, addedBody);

        announce("Added to cart.");
        hideError();

        // Best-effort fan-out so theme cart drawers / badges refresh without
        // us needing to know which theme is running. Dawn-family themes and
        // most custom themes listen to one or more of these.
        const evts = [
          "tryonai:added-to-cart",
          "cart:refresh",
          "cart:updated",
          "cart:added",
          "cart:item-added",
        ];
        evts.forEach((name) =>
          document.dispatchEvent(new CustomEvent(name, { detail: { variantId } }))
        );

        // Visible confirmation on the button itself, then close the modal.
        const labelSpan = addToCartBtn.querySelector("span");
        const originalLabel = labelSpan ? labelSpan.textContent : "";
        if (labelSpan) labelSpan.textContent = "Added ✓";
        setTimeout(() => {
          if (labelSpan) labelSpan.textContent = originalLabel;
          closeModal();
        }, 700);
      } catch (err) {
        showError(err.message || "Add to cart failed");
      } finally {
        addToCartBtn.disabled = false;
      }
    }

    // Best-effort attribution beacon so the app can count tool-driven add-to-carts
    // (and the cart value they drove) on the private owner dashboard. Fire-and-
    // forget: it never blocks the UX, never surfaces errors, and `keepalive` lets
    // it complete even though the modal closes ~700ms later. The server refuses
    // any beacon whose requestId doesn't match a real try-on, so this can't be
    // used to inflate the numbers.
    function reportCartAdd(variantId, addedBody) {
      try {
        // Without the originating try-on id the server can't verify/attribute it.
        if (!state.requestId) return;
        const item =
          addedBody && Array.isArray(addedBody.items)
            ? addedBody.items[0]
            : addedBody;
        const toInt = (v) => {
          const n = Number(v);
          return Number.isFinite(n) ? Math.round(n) : null;
        };
        const priceCents = item ? toInt(item.price) : null;
        const lineValueCents = item
          ? toInt(item.final_line_price != null ? item.final_line_price : item.line_price)
          : null;
        const quantity = (item && toInt(item.quantity)) || 1;
        const currency =
          (window.Shopify &&
            window.Shopify.currency &&
            window.Shopify.currency.active) ||
          null;
        fetch("/apps/tryonai/cart-event", {
          method: "POST",
          credentials: "same-origin",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: state.requestId,
            productHandle: productHandle || null,
            variantId: variantId != null ? String(variantId) : null,
            quantity,
            priceCents,
            lineValueCents,
            currency,
          }),
        }).catch(() => {
          /* network failure is non-fatal for tracking */
        });
      } catch (_) {
        /* attribution must never affect the add-to-cart flow */
      }
    }

    function announce(text) {
      if (live) live.textContent = text;
    }
    function showError(text, code) {
      let message = text || "Something went wrong.";
      // Map OpenAI's safety/moderation rejection to friendly, actionable
      // guidance. The server sends code "safety_rejected" with this copy; the
      // regex is a fallback for when the server isn't yet redeployed (it still
      // sends the raw OpenAI "rejected by the safety system" text).
      if (
        code === "safety_rejected" ||
        /safety system|rejected by the safety/i.test(message)
      ) {
        message =
          "We couldn't create a try-on from that photo. For best results, " +
          "upload a clear, well-lit photo of just you, facing the camera — " +
          "with no one else in the frame.";
      }
      if (errorEl) {
        errorEl.textContent = message;
        errorEl.hidden = false;
      }
      panelErrorEl.textContent = message;
      panelErrorEl.hidden = false;
    }
    function hideError() {
      if (errorEl) {
        errorEl.hidden = true;
        errorEl.textContent = "";
      }
      panelErrorEl.hidden = true;
      panelErrorEl.textContent = "";
    }
  }

  // ============ Garment auto-detect (unchanged from prior fix) ============
  async function resolveProductGarment({ productHandle, hintedImageUrl }) {
    const candidate = hintedImageUrl || (await lookupProductImage(productHandle));
    if (!candidate) return null;
    const file = await fetchAsFile(candidate, productHandle);
    if (!file) return null;
    // Stash the resolved CDN URL on the File so the caller can reuse the exact
    // canonical URL the blob was fetched from (for stable result-cache keying)
    // without re-resolving or refetching.
    try { file.tryonaiSourceUrl = candidate; } catch (_) { /* non-fatal */ }
    return file;
  }

  async function lookupProductImage(productHandle) {
    if (!productHandle || !/^[a-z0-9][a-z0-9-]*$/i.test(productHandle)) return null;
    try {
      const res = await fetch(`/products/${encodeURIComponent(productHandle)}.js`, {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      if (!res.ok) return null;
      const product = await res.json();
      const raw =
        product.featured_image ||
        (product.images && product.images[0]) ||
        (product.media && product.media[0] && (product.media[0].preview_image?.src || product.media[0].src)) ||
        null;
      return normalizeImageUrl(raw);
    } catch (err) {
      console.warn("[tryonai] /products/<handle>.js lookup failed", err);
      return null;
    }
  }

  async function fetchAsFile(imageUrl, productHandle) {
    const res = await fetch(imageUrl, { credentials: "omit" });
    if (!res.ok) throw new Error(`Image fetch ${res.status}`);
    const mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const blob = await res.blob();
    const finalMime = SUPPORTED_MIME.has(mime) ? mime : blob.type;
    if (!SUPPORTED_MIME.has(finalMime)) {
      throw new Error(`Unsupported image mime ${finalMime || "unknown"}`);
    }
    if (blob.size > MAX_GARMENT_BYTES) {
      throw new Error("Product image exceeds 8MB");
    }
    const ext = finalMime === "image/png" ? "png" : finalMime === "image/webp" ? "webp" : "jpg";
    const name = `product-${productHandle || "item"}.${ext}`;
    return new File([blob], name, { type: finalMime });
  }

  function normalizeImageUrl(url) {
    if (!url) return "";
    if (url.startsWith("//")) return window.location.protocol + url;
    if (url.startsWith("/")) return window.location.origin + url;
    return url;
  }

  // Walks up from the launcher to a product section, then picks the image the
  // shopper is currently viewing (active media item, selected slide, or the
  // largest visible product image). Falls back to "" so callers can use the
  // Liquid-provided hint as a final fallback.
  function findCurrentGalleryImage(launcherEl) {
    if (!launcherEl) return "";
    const section =
      launcherEl.closest(
        '[data-section-type="product"], [data-section-id][id*="product"], main[role="main"], main, .product, .product-section, [id*="product-section"]'
      ) || document.body;

    const sels = [
      ".product__media-item.is-active img",
      "[data-media-id].is-active img",
      ".product__media.is-active img",
      ".product-single__photo.active img",
      ".product__photo.active img",
      ".flickity-slider .is-selected img",
      ".swiper-slide-active img",
      ".splide__slide.is-active img",
      '[aria-current="true"] img',
      ".product-gallery__media.is-active img",
      ".product-gallery__media--active img",
      "[data-product-image]",
      ".product__main-image img",
      ".product-gallery__main img",
    ];
    for (const sel of sels) {
      const el = section.querySelector(sel);
      const url = pickImgUrl(el);
      if (url && isVisible(el)) return normalizeImageUrl(upgradeShopifyImage(url));
    }

    // Fallback: largest visible product image in any gallery-ish container.
    const candidates = section.querySelectorAll(
      '.product__media img, .product-gallery img, .product-single__photo img, .product__photo img, [class*="gallery"] img, [class*="Gallery"] img'
    );
    let best = null, bestArea = 0;
    candidates.forEach((img) => {
      if (!isVisible(img)) return;
      const r = img.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = img; bestArea = area; }
    });
    return best ? normalizeImageUrl(upgradeShopifyImage(pickImgUrl(best))) : "";
  }

  function pickImgUrl(el) {
    if (!el) return "";
    if (el.tagName === "IMG") {
      return el.currentSrc || el.src || el.dataset.src || el.dataset.zoomImage || "";
    }
    return (
      el.getAttribute("data-product-image") ||
      el.getAttribute("data-zoom-image") ||
      el.getAttribute("src") ||
      ""
    );
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.hidden || el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 40;
  }

  // Shopify CDN URLs often include a small `_180x` or `_400x` size suffix when
  // they're rendered in a thumbnail. Upgrade to a 1024-wide version for fitting.
  function upgradeShopifyImage(url) {
    if (!url) return url;
    if (!/cdn\.shopify\.com|shopifycdn\.com/.test(url)) return url;
    try {
      const u = new URL(url, window.location.origin);
      // Path-based size: ..._180x.jpg or ..._180x240.jpg
      u.pathname = u.pathname.replace(/_(\d+)?x(\d+)?(?=\.[a-z]+($|\?))/i, "_1024x");
      // Query-based size: ?width=180
      if (u.searchParams.has("width")) u.searchParams.set("width", "1024");
      return u.toString();
    } catch (_) {
      return url;
    }
  }

  function pickSizeFromRatio(width, height) {
    if (!width || !height) return "1024x1536";
    const ratio = width / height;
    if (ratio > 1.05) return "1536x1024";
    // Portrait and near-square both map to 1024x1536. Square (1024x1024) is no
    // longer offered — it is the most expensive output path, and the server
    // rejects it anyway, falling back to 1024x1536.
    return "1024x1536";
  }

  // Decode the file once, downsample to maxEdge if oversized, and re-encode as
  // JPEG. Returns the (possibly resized) File plus its final dimensions so the
  // caller can avoid a second decode for aspect-ratio detection. PNG inputs are
  // always re-encoded to JPEG (alpha isn't useful for try-on photos and JPEG is
  // 5-10x smaller). Files already <= maxEdge in JPEG/WebP pass through untouched.
  async function downsampleImage(file, maxEdge = 1024) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (_) {
      throw new Error("Image decode failed");
    }
    const width = bitmap.width;
    const height = bitmap.height;
    const longEdge = Math.max(width, height);
    if (longEdge <= maxEdge && file.type !== "image/png") {
      bitmap.close?.();
      return { file, width, height };
    }
    const scale = longEdge > maxEdge ? maxEdge / longEdge : 1;
    const outW = Math.max(1, Math.round(width * scale));
    const outH = Math.max(1, Math.round(height * scale));

    let canvas;
    if (typeof OffscreenCanvas !== "undefined") {
      canvas = new OffscreenCanvas(outW, outH);
    } else {
      canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
    }
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, outW, outH);
    bitmap.close?.();

    const blob = await (canvas.convertToBlob
      ? canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 })
      : new Promise((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", 0.9),
        ));
    if (!blob) throw new Error("Image encode failed");
    const baseName = (file.name || "image").replace(/\.[^.]+$/, "");
    const out = new File([blob], baseName + ".jpg", { type: "image/jpeg" });
    return { file: out, width: outW, height: outH };
  }
})();
