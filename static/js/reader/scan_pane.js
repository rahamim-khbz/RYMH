// Fixed aspect-ratio manuscript scan strip with N±1 preload,
// WebP phone-scan support with img fallback, zero layout shift,
// and hover-only line/paragraph highlighting.
window.ReaderScanPane = (function () {
  'use strict';
  // UI language (ui_prefs.js): note text stays Hebrew; only the interface switches.
  var IS_EN = typeof window !== 'undefined' && window.RYMH_LANG === 'en';
  function L(he, en) { return IS_EN ? en : he; }

  function createScanPane(options) {
    var opts = options || {};
    var paneEl = opts.paneEl;
    var trackEl = opts.trackEl;
    var pagesIndex = opts.pagesIndex || [];
    var onHoverLine = typeof opts.onHoverLine === 'function' ? opts.onHoverLine : function () {};
    var onZoomPanStateChange = typeof opts.onZoomPanStateChange === 'function' ? opts.onZoomPanStateChange : function () {};

    var slotsByN = {};
    var mountedNs = {};
    var webpFailed = {};
    var preloaded = {};
    var indexByN = {};
    var zoomScale = 1;
    var panActive = false;
    var panStartX = 0;
    var panStartY = 0;
    var panStartScrollLeft = 0;
    var panStartScrollTop = 0;
    var activeHoveredEl = null;

    for (var i = 0; i < pagesIndex.length; i++) {
      indexByN[pagesIndex[i].n] = pagesIndex[i];
    }

    function el(tag, cls, text) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }

    function initSlots() {
      if (!trackEl) return;
      trackEl.textContent = '';
      var frag = document.createDocumentFragment();
      for (var i = 0; i < pagesIndex.length; i++) {
        var p = pagesIndex[i];
        var w = p.w || 2550;
        var h = p.h || 3300;
        var slot = el('section', 'scan-slot');
        slot.setAttribute('data-page', p.page);
        slot.setAttribute('data-n', String(p.n));
        slot.setAttribute('aria-label', L('הדפוס עמוד ', 'Printed page ') + p.n);
        slot.style.aspectRatio = w + ' / ' + h;
        slotsByN[p.n] = slot;
        frag.appendChild(slot);
      }
      trackEl.appendChild(frag);
    }

    function preferredScanSrc(meta) {
      if (!meta) return '';
      if (!webpFailed[meta.n] && meta.webp) return meta.webp;
      return meta.img || '';
    }

    function preloadOne(n) {
      var meta = indexByN[n];
      if (!meta || preloaded[n]) return;
      preloaded[n] = true;
      var img = new Image();
      img.decoding = 'async';
      var primary = preferredScanSrc(meta);
      if (!primary) return;
      img.onerror = function () {
        if (!webpFailed[n] && meta.webp && primary === meta.webp && meta.img) {
          webpFailed[n] = true;
          var fallback = new Image();
          fallback.decoding = 'async';
          fallback.src = meta.img;
        }
      };
      img.src = primary;
    }

    function preloadAround(centerN) {
      preloadOne(centerN - 1);
      preloadOne(centerN);
      preloadOne(centerN + 1);
    }

    function buildLineBox(pageId, paraPid, line, w, h, kind) {
      var box = line.box || [0, 0, 0, 0];
      var node = el('div', kind === 'footnote' ? 'scan-line-box scan-fn-box' : 'scan-line-box');
      node.setAttribute('data-page', pageId);
      if (paraPid) node.setAttribute('data-para', paraPid);
      node.setAttribute('data-line-id', line.id);
      node.setAttribute('data-kind', kind);
      node.style.left = ((box[0] / w) * 100).toFixed(4) + '%';
      node.style.top = ((box[1] / h) * 100).toFixed(4) + '%';
      node.style.width = ((box[2] / w) * 100).toFixed(4) + '%';
      node.style.height = ((box[3] / h) * 100).toFixed(4) + '%';
      return node;
    }

    function mountSlot(n, pageData) {
      var slot = slotsByN[n];
      if (!slot || !pageData || mountedNs[n]) return;

      var w = pageData.w || 2550;
      var h = pageData.h || 3300;
      slot.style.aspectRatio = w + ' / ' + h;
      slot.textContent = '';

      var badge = el('div', 'scan-page-badge', L('עמוד ', 'Page ') + pageData.n);
      badge.setAttribute('dir', 'rtl');
      slot.appendChild(badge);

      var img = document.createElement('img');
      img.className = 'scan-img';
      img.width = w;
      img.height = h;
      img.decoding = 'async';
      img.draggable = false;
      img.alt = L('הדפוס עמוד ', 'Printed page ') + pageData.n;
      var primary = preferredScanSrc(pageData);
      img.addEventListener('error', function () {
        if (pageData.webp && img.getAttribute('src') === pageData.webp && pageData.img) {
          webpFailed[n] = true;
          img.src = pageData.img;
        }
      });
      if (lazyIO) {
        // Flow mode keeps all 89 slots mounted: fetch a scan only when it nears the viewport.
        img.setAttribute('data-src', primary);
        lazyIO.observe(slot);
      } else {
        img.src = primary;
      }
      slot.appendChild(img);

      var overlay = el('div', 'scan-overlay');
      overlay.setAttribute('dir', 'ltr');

      var paras = pageData.paragraphs || [];
      for (var i = 0; i < paras.length; i++) {
        var para = paras[i];
        var lines = para.lines || [];
        if (lines.length) {
          var minY = Infinity;
          var maxY = -Infinity;
          for (var j = 0; j < lines.length; j++) {
            var b = lines[j].box || [0, 0, 0, 0];
            if (b[1] < minY) minY = b[1];
            if (b[1] + b[3] > maxY) maxY = b[1] + b[3];
          }
          if (minY < maxY && isFinite(minY)) {
            var anchor = el('div', 'scan-para-anchor');
            anchor.setAttribute('data-page', pageData.page);
            anchor.setAttribute('data-para', para.pid);
            anchor.style.top = ((minY / h) * 100).toFixed(4) + '%';
            anchor.style.height = (((maxY - minY) / h) * 100).toFixed(4) + '%';
            overlay.appendChild(anchor);
          }
          for (var k = 0; k < lines.length; k++) {
            overlay.appendChild(buildLineBox(pageData.page, para.pid, lines[k], w, h, 'main'));
          }
        }
      }

      var notes = pageData.notes || [];
      for (var ni = 0; ni < notes.length; ni++) {
        var nt = notes[ni];
        var nlines = nt.lines || [];
        for (var nli = 0; nli < nlines.length; nli++) {
          overlay.appendChild(buildLineBox(pageData.page, null, nlines[nli], w, h, 'footnote'));
        }
      }

      slot.appendChild(overlay);
      slot.classList.add('is-mounted');
      mountedNs[n] = true;
    }

    function unmountSlot(n) {
      var slot = slotsByN[n];
      if (!slot || !mountedNs[n]) return;
      slot.textContent = '';
      slot.classList.remove('is-mounted');
      delete mountedNs[n];
    }

    var lazyIO = null;
    if (document.documentElement.classList.contains('flow-mode') && window.IntersectionObserver) {
      lazyIO = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (!entries[i].isIntersecting) continue;
          var im = entries[i].target.querySelector('img[data-src]');
          if (im) { im.src = im.getAttribute('data-src'); im.removeAttribute('data-src'); }
          lazyIO.unobserve(entries[i].target);
        }
      }, { root: paneEl, rootMargin: '1500px 0px' });
    }

    // Backup for the lazy loader: make sure the scans around page n are fetched.
    function ensureLoaded(n) {
      if (!lazyIO || !trackEl) return;
      for (var k = n - 2; k <= n + 2; k++) {
        var im = trackEl.querySelector('.scan-slot[data-n="' + k + '"] img[data-src]');
        if (im) { im.src = im.getAttribute('data-src'); im.removeAttribute('data-src'); }
      }
    }

    function setWindow(wantedNs, getCachedPage) {
      var wantedSet = {};
      for (var i = 0; i < wantedNs.length; i++) {
        wantedSet[wantedNs[i]] = true;
      }
      var currentKeys = Object.keys(mountedNs);
      for (var j = 0; j < currentKeys.length; j++) {
        var k = Number(currentKeys[j]);
        if (!wantedSet[k]) unmountSlot(k);
      }
      for (var m = 0; m < wantedNs.length; m++) {
        var n = wantedNs[m];
        if (!mountedNs[n]) {
          var pageData = getCachedPage(n);
          if (pageData) mountSlot(n, pageData);
        }
      }
    }

    function highlight(pageId, lineId, paraPid, active) {
      if (!trackEl) return;
      if (lineId) {
        var boxes = trackEl.querySelectorAll('.scan-line-box[data-line-id]');
        for (var i = 0; i < boxes.length; i++) {
          if (boxes[i].getAttribute('data-line-id') === lineId &&
              (!pageId || boxes[i].getAttribute('data-page') === pageId)) {
            boxes[i].classList.toggle('is-hover', !!active);
          }
        }
      }
      if (paraPid) {
        var paras = trackEl.querySelectorAll('.scan-para-anchor[data-para]');
        for (var j = 0; j < paras.length; j++) {
          if (paras[j].getAttribute('data-para') === paraPid) {
            paras[j].classList.toggle('is-hover', !!active);
          }
        }
      }
    }

    function clearHover() {
      if (!trackEl) return;
      var active = trackEl.querySelectorAll('.is-hover');
      for (var i = 0; i < active.length; i++) active[i].classList.remove('is-hover');
    }

    function setZoom(scale) {
      var next = Math.min(2.5, Math.max(1, Math.round(scale * 10) / 10));
      zoomScale = next;
      if (trackEl) {
        trackEl.style.width = next === 1 ? '' : (next * 100) + '%';
        trackEl.classList.toggle('is-zoomed', next > 1);
      }
      return zoomScale;
    }

    function attachEvents() {
      if (!trackEl) return;
      trackEl.addEventListener('pointerover', function (e) {
        var box = e.target && e.target.closest ? e.target.closest('.scan-line-box') : null;
        if (box === activeHoveredEl) return;
        if (activeHoveredEl) {
          onHoverLine(
            activeHoveredEl.getAttribute('data-page'),
            activeHoveredEl.getAttribute('data-line-id'),
            activeHoveredEl.getAttribute('data-para'),
            false
          );
          activeHoveredEl = null;
        }
        if (box) {
          activeHoveredEl = box;
          onHoverLine(
            box.getAttribute('data-page'),
            box.getAttribute('data-line-id'),
            box.getAttribute('data-para'),
            true
          );
        }
      });

      trackEl.addEventListener('pointerleave', function () {
        if (activeHoveredEl) {
          onHoverLine(
            activeHoveredEl.getAttribute('data-page'),
            activeHoveredEl.getAttribute('data-line-id'),
            activeHoveredEl.getAttribute('data-para'),
            false
          );
          activeHoveredEl = null;
        }
      });

      if (paneEl) {
        paneEl.addEventListener('pointerdown', function (e) {
          if (zoomScale <= 1 || e.button !== 0) return;
          panActive = true;
          panStartX = e.clientX;
          panStartY = e.clientY;
          panStartScrollLeft = paneEl.scrollLeft;
          panStartScrollTop = paneEl.scrollTop;
          onZoomPanStateChange(true);
        });
        paneEl.addEventListener('pointermove', function (e) {
          if (!panActive) return;
          paneEl.scrollLeft = panStartScrollLeft - (e.clientX - panStartX);
          paneEl.scrollTop = panStartScrollTop - (e.clientY - panStartY);
        });
        var endPan = function () {
          if (!panActive) return;
          panActive = false;
          onZoomPanStateChange(false);
        };
        paneEl.addEventListener('pointerup', endPan);
        paneEl.addEventListener('pointercancel', endPan);
      }
    }

    initSlots();
    attachEvents();

    return {
      mountSlot: mountSlot,
      unmountSlot: unmountSlot,
      setWindow: setWindow,
      ensureLoaded: ensureLoaded,
      preloadAround: preloadAround,
      highlight: highlight,
      clearHover: clearHover,
      setZoom: setZoom,
      getZoom: function () { return zoomScale; },
      isMounted: function (n) { return !!mountedNs[n]; }
    };
  }

  return { create: createScanPane };
})();
