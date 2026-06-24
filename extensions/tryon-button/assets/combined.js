// Combined launcher: one button that opens a chooser so the shopper picks which
// of the enabled tools to start (Virtual Try-On, AI Outfit Stylist, Size
// Recommender). Opt-in via the block's "How buttons appear" setting. The three
// feature modules still boot on their own roots (kept in the DOM but headless —
// their own buttons hidden via CSS); this module reuses the shared kit modal for
// the chooser and dispatches to each root's `__tryonaiOpen` handle, resolved at
// click time so script load order is irrelevant.

(function () {
  "use strict";
  if (window.__tryonaiCombinedBooted) return;
  window.__tryonaiCombinedBooted = true;

  var K = window.TryonaiKit;
  if (!K) {
    console.warn("[tryonai] combined launcher: kit not loaded");
    return;
  }

  // Order here is the order shown in the chooser.
  var FEATURES = [
    { key: "tryon", selector: ".tryonai-root", labelAttr: "labelTryon", fallback: "Try it on", glyph: "fit" },
    { key: "outfit", selector: ".tryonai-outfit-root", labelAttr: "labelOutfit", fallback: "Help me pick an outfit", glyph: "palette" },
    { key: "size", selector: ".tryonai-size-root", labelAttr: "labelSize", fallback: "Find my size", glyph: "ruler" },
  ];

  function boot() {
    document.querySelectorAll(".tryonai-combined-root").forEach(initRoot);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  function initRoot(root) {
    var launcher = root.querySelector(".tryonai-combined-launcher");
    if (!launcher) return;

    var ctx = {
      theme: root.dataset.theme || "atelier",
      shape: root.dataset.buttonShape || "pill",
      accent: root.style.getPropertyValue("--tryonai-accent") || "",
    };

    // Resolve which feature roots actually rendered for THIS block. Scope to the
    // shared parent so two blocks on one page don't cross-wire; fall back to the
    // document if a theme wraps the block differently.
    function features() {
      var scope = root.parentElement || document;
      return FEATURES.map(function (f) {
        var el = scope.querySelector(f.selector) || document.querySelector(f.selector);
        return el ? { key: f.key, el: el, label: root.dataset[f.labelAttr] || f.fallback, glyph: f.glyph } : null;
      }).filter(Boolean);
    }

    function open(el) {
      var fn = el && el.__tryonaiOpen;
      if (typeof fn === "function") fn();
    }

    launcher.addEventListener("click", function () {
      var list = features();
      if (list.length === 0) return;
      // Only one tool enabled: skip the chooser and open it directly.
      if (list.length === 1) {
        open(list[0].el);
        return;
      }
      openChooser(list);
    });

    function openChooser(list) {
      var ui = K.createModal({ theme: ctx.theme, shape: ctx.shape, accent: ctx.accent });
      var title = root.dataset.chooserTitle || "What would you like to do?";
      var showIcon = root.dataset.showIcon !== "false";
      ui.modal.setAttribute("aria-label", title);

      ui.content.innerHTML =
        '<div class="tryonai-k-intro"><h2 class="tryonai-k-h">' + K.esc(title) + "</h2></div>" +
        '<div class="tryonai-chooser" role="list">' +
        list.map(function (f) {
          var glyph = showIcon
            ? '<span class="tryonai-chooser__glyph" aria-hidden="true">' +
              '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><g>' +
              (K.GLYPHS[f.glyph] || K.GLYPHS.finish) +
              "</g></svg></span>"
            : "";
          return (
            '<button type="button" class="tryonai-chooser__item" role="listitem" data-choose="' + K.esc(f.key) + '">' +
            glyph +
            '<span class="tryonai-chooser__label">' + K.esc(f.label) + "</span>" +
            '<span class="tryonai-chooser__arrow" aria-hidden="true">' +
            '<svg viewBox="0 0 28 12" width="24" height="11" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="square"><path d="M0 6h26M21 1l5 5-5 5"/></svg>' +
            "</span></button>"
          );
        }).join("") +
        "</div>";

      ui.content.querySelectorAll("[data-choose]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var chosen = null;
          for (var i = 0; i < list.length; i++) {
            if (list[i].key === btn.dataset.choose) { chosen = list[i]; break; }
          }
          if (!chosen) return;
          // Close the chooser first so its scroll-lock/focus reset cleanly, then
          // open the chosen flow on the next frame (the try-on flow runs its own
          // scroll-lock, which would otherwise fight the kit modal's).
          ui.close();
          requestAnimationFrame(function () { open(chosen.el); });
        });
      });

      ui.open();
    }
  }
})();
