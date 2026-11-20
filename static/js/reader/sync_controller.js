// Single SyncController for the public reader.
// Owns all scroll panes using [data-page][data-para] anchors, a 30% reading line,
// 150 ms leader lock to prevent echo loops, 48 px page-boundary hysteresis,
// and ResizeObserver + document.fonts.ready re-sync.
window.ReaderSyncController = (function () {
  'use strict';

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function parsePageN(pageId) {
    if (!pageId) return 0;
    var m = /(\d+)$/.exec(String(pageId));
    return m ? parseInt(m[1], 10) : 0;
  }

  function createSyncController(options) {
    var opts = options || {};
    var readingRatio = typeof opts.readingRatio === 'number' ? opts.readingRatio : 0.30;
    var lockMs = typeof opts.lockMs === 'number' ? opts.lockMs : 150;
    var hysteresisPx = typeof opts.hysteresisPx === 'number' ? opts.hysteresisPx : 48;
    var minViewportResizeDelta = typeof opts.minViewportResizeDelta === 'number' ? opts.minViewportResizeDelta : 60;
    var onPageChange = typeof opts.onPageChange === 'function' ? opts.onPageChange : function () {};
    var onAnchorChange = typeof opts.onAnchorChange === 'function' ? opts.onAnchorChange : function () {};

    var panes = []; // { id, el, contentEl, ignoreScrollUntil, lastInteractAt, lastW, lastH, lastContentH, listeners }
    var paneById = {};
    var activeLeaderId = null;
    var leaderLockUntil = 0;
    var currentPageN = 1;
    var lastAnchor = null;
    var paused = false;
    var resizeSuppressed = false;
    var rafPending = false;
    var resizeRafPending = false;
    var resizeObserver = null;
    var destroyed = false;

    var PARA_SELECTOR = '[data-para]:not(.rline)';

    function findAnchorEl(paneEl, pid) {
      if (!paneEl || !pid) return null;
      var anchors = paneEl.querySelectorAll(PARA_SELECTOR);
      for (var i = 0; i < anchors.length; i++) {
        if (anchors[i].getAttribute('data-para') === pid) return anchors[i];
      }
      return null;
    }

    function getVisibleAnchors(paneEl) {
      var list = paneEl.querySelectorAll(PARA_SELECTOR);
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        var rect = el.getBoundingClientRect();
        if (rect.height <= 0 && rect.width <= 0) continue;
        out.push({
          el: el,
          rect: rect,
          pid: el.getAttribute('data-para'),
          page: el.getAttribute('data-page'),
          n: parsePageN(el.getAttribute('data-page'))
        });
      }
      return out;
    }

    function captureAnchor(pane) {
      if (!pane || !pane.el) return null;
      var paneRect = pane.el.getBoundingClientRect();
      if (paneRect.height <= 0 || pane.el.clientHeight <= 0) return null;

      var anchors = getVisibleAnchors(pane.el);
      if (!anchors.length) return null;

      var lineY = paneRect.top + pane.el.clientHeight * readingRatio;
      var first = anchors[0];
      if (lineY < first.rect.top) {
        return {
          mode: 'above',
          page: first.page,
          n: first.n,
          pid: first.pid,
          frac: 0,
          offsetFromTop: first.rect.top - paneRect.top
        };
      }

      for (var i = 0; i < anchors.length; i++) {
        var cur = anchors[i];
        if (lineY <= cur.rect.bottom) {
          var frac = (lineY - cur.rect.top) / Math.max(1, cur.rect.height);
          return {
            mode: 'para',
            page: cur.page,
            n: cur.n,
            pid: cur.pid,
            frac: clamp(frac, 0, 1)
          };
        }
        if (i + 1 < anchors.length) {
          var next = anchors[i + 1];
          if (lineY < next.rect.top) {
            var gap = Math.max(1, next.rect.top - cur.rect.bottom);
            var gapFrac = clamp((lineY - cur.rect.bottom) / gap, 0, 1);
            return {
              mode: 'gap',
              page: cur.page,
              n: cur.n,
              pid: cur.pid,
              nextPid: next.pid,
              frac: 1,
              gapFrac: gapFrac
            };
          }
        }
      }

      var last = anchors[anchors.length - 1];
      return {
        mode: 'para',
        page: last.page,
        n: last.n,
        pid: last.pid,
        frac: 1
      };
    }

    function applyAnchorToPane(pane, anchor, alignReadingLine) {
      if (!pane || !pane.el || !anchor) return;
      var paneRect = pane.el.getBoundingClientRect();
      if (paneRect.height <= 0 || pane.el.clientHeight <= 0) return;

      var lineY = paneRect.top + pane.el.clientHeight * readingRatio;
      var targetEl = findAnchorEl(pane.el, anchor.pid);
      if (!targetEl && anchor.page) {
        targetEl = pane.el.querySelector('[data-page="' + anchor.page + '"]');
      }
      if (!targetEl) return;

      var targetRect = targetEl.getBoundingClientRect();
      var delta = 0;

      if (anchor.mode === 'above' && !alignReadingLine) {
        delta = targetRect.top - (paneRect.top + (anchor.offsetFromTop || 0));
      } else if (anchor.mode === 'gap' && anchor.nextPid) {
        var nextEl = findAnchorEl(pane.el, anchor.nextPid);
        var targetY = targetRect.bottom;
        if (nextEl) {
          var nextRect = nextEl.getBoundingClientRect();
          if (nextRect.top >= targetRect.bottom) {
            targetY = targetRect.bottom + anchor.gapFrac * (nextRect.top - targetRect.bottom);
          }
        }
        delta = targetY - lineY;
      } else {
        var f = typeof anchor.frac === 'number' ? anchor.frac : 0;
        var y = targetRect.top + f * targetRect.height;
        delta = y - lineY;
      }

      var maxScroll = Math.max(0, pane.el.scrollHeight - pane.el.clientHeight);
      var nextTop = clamp(pane.el.scrollTop + delta, 0, maxScroll);
      if (Math.abs(nextTop - pane.el.scrollTop) >= 0.5) {
        pane.ignoreScrollUntil = performance.now() + lockMs;
        pane.el.scrollTop = nextTop;
      }
    }

    function firstAnchorTopForSlot(slot) {
      var firstPara = slot.querySelector(PARA_SELECTOR);
      var rect = (firstPara || slot).getBoundingClientRect();
      return rect.top;
    }

    function computePageWithHysteresis(leader) {
      if (!leader || !leader.el) return currentPageN;
      if (leader.el.scrollTop <= 2) return 1;
      var paneRect = leader.el.getBoundingClientRect();
      if (paneRect.height <= 0 || leader.el.clientHeight <= 0) return currentPageN;

      var lineY = paneRect.top + leader.el.clientHeight * readingRatio;
      var slots = leader.el.querySelectorAll('.page-slot[data-n], .scan-slot[data-n]');
      if (!slots.length) return currentPageN;

      var curN = currentPageN || 1;
      var curSlot = null;
      var forwardBest = 0;
      var slotInfos = [];

      for (var i = 0; i < slots.length; i++) {
        var s = slots[i];
        var n = parseInt(s.getAttribute('data-n'), 10);
        if (!n) continue;
        var top = firstAnchorTopForSlot(s);
        slotInfos.push({ n: n, top: top });
        if (n === curN) curSlot = { n: n, top: top };
        if (n > curN && top <= lineY) {
          if (n > forwardBest) forwardBest = n;
        }
      }

      if (forwardBest > curN) {
        return forwardBest;
      }

      // Moving backward requires crossing back past the reading line by hysteresisPx (48 px).
      if (curN > 1 && (!curSlot || curSlot.top > lineY + hysteresisPx)) {
        var backBest = 1;
        for (var j = 0; j < slotInfos.length; j++) {
          var info = slotInfos[j];
          if (info.n < curN && info.top <= lineY) {
            backBest = info.n;
          }
        }
        // If we jumped/scrolled slightly past curN boundary and the immediately preceding page
        // is also above lineY + hysteresis, use backBest; otherwise stay on curN - 1 if within band.
        if (backBest + 1 < curN) {
          for (var k = 0; k < slotInfos.length; k++) {
            if (slotInfos[k].n === backBest + 1 && slotInfos[k].top <= lineY + hysteresisPx) {
              return backBest + 1;
            }
          }
        }
        return backBest;
      }

      return curN;
    }

    function syncFromLeader(leader) {
      if (!leader || paused || destroyed) return;

      if (leader.el.scrollTop <= 2) {
        if (currentPageN !== 1) {
          currentPageN = 1;
          onPageChange(1, leader.id);
        }
        lastAnchor = { mode: 'top', page: 'page-01', n: 1, pid: 'page-01:0', frac: 0 };
        onAnchorChange(lastAnchor);
        for (var fi = 0; fi < panes.length; fi++) {
          var fPane = panes[fi];
          if (fPane.id === leader.id) continue;
          if (Math.abs(fPane.el.scrollTop) >= 0.5) {
            fPane.ignoreScrollUntil = performance.now() + lockMs;
            fPane.el.scrollTop = 0;
          }
        }
        return;
      }

      var nextN = computePageWithHysteresis(leader);
      if (nextN && nextN !== currentPageN) {
        currentPageN = nextN;
        onPageChange(nextN, leader.id);
      }

      var anchor = captureAnchor(leader);
      if (anchor) {
        if (anchor.n === currentPageN) lastAnchor = anchor;
        onAnchorChange(anchor);
      } else {
        return;
      }

      for (var i = 0; i < panes.length; i++) {
        var follower = panes[i];
        if (follower.id === leader.id) continue;
        applyAnchorToPane(follower, anchor, false);
      }
    }

    function flushSync() {
      rafPending = false;
      if (paused || destroyed) return;
      var leader = (activeLeaderId && paneById[activeLeaderId]) || panes[0];
      syncFromLeader(leader);
    }

    function scheduleSync() {
      if (rafPending || paused || destroyed) return;
      rafPending = true;
      requestAnimationFrame(flushSync);
    }

    function handleInteraction(pane) {
      var now = performance.now();
      activeLeaderId = pane.id;
      leaderLockUntil = now + lockMs;
      pane.ignoreScrollUntil = 0;
      pane.selfEchoUntil = 0;
      pane.lastInteractAt = now;
    }

    function handleScroll(pane) {
      if (paused || destroyed) return;
      if (pane.el.clientHeight <= 0 || pane.el.clientWidth <= 0) return;

      var now = performance.now();
      if (now < pane.selfEchoUntil && Math.abs(pane.el.scrollTop - pane.selfEchoTop) < 1) {
        return;
      }
      if (now < pane.ignoreScrollUntil) {
        return;
      }
      if (activeLeaderId && activeLeaderId !== pane.id && now < leaderLockUntil) {
        return;
      }

      activeLeaderId = pane.id;
      leaderLockUntil = now + lockMs;
      scheduleSync();
    }

    function handleResizeEntries(entries) {
      if (paused || resizeSuppressed || destroyed) return;
      var now = performance.now();
      var meaningful = false;
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var target = entry.target;
        for (var j = 0; j < panes.length; j++) {
          var p = panes[j];
          if (target === p.el) {
            var cw = p.el.clientWidth;
            var ch = p.el.clientHeight;
            if (cw !== p.lastW) {
              p.lastW = cw;
              p.lastH = ch;
              meaningful = true;
            } else if (Math.abs(ch - p.lastH) >= minViewportResizeDelta || now >= leaderLockUntil) {
              if (ch !== p.lastH) {
                p.lastH = ch;
                meaningful = true;
              }
            }
          } else if (target === p.contentEl) {
            var contentH = p.contentEl.scrollHeight;
            if (contentH !== p.lastContentH) {
              p.lastContentH = contentH;
              if (now >= leaderLockUntil) meaningful = true;
            }
          }
        }
      }
      if (!meaningful || resizeRafPending) return;
      resizeRafPending = true;
      requestAnimationFrame(function () {
        resizeRafPending = false;
        if (!paused && !resizeSuppressed && !destroyed) {
          resyncLayout();
        }
      });
    }

    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(handleResizeEntries);
    }

    function registerPane(id, el, contentEl) {
      if (!id || !el || paneById[id]) return;
      var pane = {
        id: id,
        el: el,
        contentEl: contentEl || el,
        ignoreScrollUntil: 0,
        selfEchoUntil: 0,
        selfEchoTop: 0,
        lastInteractAt: 0,
        lastW: el.clientWidth,
        lastH: el.clientHeight,
        lastContentH: (contentEl || el).scrollHeight,
        listeners: []
      };

      function onInteract() { handleInteraction(pane); }
      function onScroll() { handleScroll(pane); }

      var interactEvents = ['pointerdown', 'wheel', 'touchstart', 'keydown'];
      for (var i = 0; i < interactEvents.length; i++) {
        el.addEventListener(interactEvents[i], onInteract, { passive: true });
        pane.listeners.push([interactEvents[i], onInteract, { passive: true }]);
      }
      el.addEventListener('scroll', onScroll, { passive: true });
      pane.listeners.push(['scroll', onScroll, { passive: true }]);

      if (resizeObserver) {
        resizeObserver.observe(el);
        if (contentEl && contentEl !== el) resizeObserver.observe(contentEl);
      }

      panes.push(pane);
      paneById[id] = pane;
      if (!activeLeaderId) activeLeaderId = id;
    }

    function resync(preferredLeaderId) {
      if (paused || destroyed || !panes.length) return;
      var leader = (preferredLeaderId && paneById[preferredLeaderId]) ||
                   (activeLeaderId && paneById[activeLeaderId]) ||
                   panes[0];
      if (!leader) return;
      syncFromLeader(leader);
    }

    function resyncLayout(preferredLeaderId) {
      if (paused || destroyed || !panes.length) return;
      var leader = (preferredLeaderId && paneById[preferredLeaderId]) ||
                   (activeLeaderId && paneById[activeLeaderId]) ||
                   panes[0];
      if (!leader) return;
      if (lastAnchor && lastAnchor.n === currentPageN && leader.el.scrollTop > 2) {
        applyAnchorToPane(leader, lastAnchor, false);
      }
      syncFromLeader(leader);
    }

    function syncFromPane(paneId) {
      var pane = paneById[paneId];
      if (!pane) return;
      activeLeaderId = paneId;
      leaderLockUntil = performance.now() + lockMs;
      syncFromLeader(pane);
    }

    function preserveAnchorAndRun(fn, preferredLeaderId) {
      var leader = (preferredLeaderId && paneById[preferredLeaderId]) ||
                   (activeLeaderId && paneById[activeLeaderId]) ||
                   panes[0];
      var saved = (leader && captureAnchor(leader)) || lastAnchor;
      var wasScrollZero = leader && leader.el.scrollTop <= 1;
      resizeSuppressed = true;
      try {
        fn();
      } finally {
        resizeSuppressed = false;
      }
      if (leader && saved && !wasScrollZero) {
        applyAnchorToPane(leader, saved, false);
      }
      syncFromLeader(leader);
    }

    function scrollToPage(paneId, pageN, opts) {
      var o = opts || {};
      var pane = paneById[paneId] || paneById[activeLeaderId] || panes[0];
      if (!pane || !pane.el) return false;
      var slot = pane.el.querySelector('.page-slot[data-n="' + pageN + '"], .scan-slot[data-n="' + pageN + '"]');
      if (!slot) return false;

      currentPageN = pageN;
      activeLeaderId = pane.id;
      leaderLockUntil = performance.now() + lockMs;

      if (pageN === 1 && !o.forceReadingLine) {
        pane.ignoreScrollUntil = 0;
        pane.el.scrollTop = 0;
        pane.selfEchoTop = pane.el.scrollTop;
        pane.selfEchoUntil = performance.now() + lockMs;
        lastAnchor = { mode: 'top', page: 'page-01', n: 1, pid: 'page-01:0', frac: 0 };
        onAnchorChange(lastAnchor);
        for (var fi = 0; fi < panes.length; fi++) {
          var fPane = panes[fi];
          if (fPane.id === pane.id) continue;
          if (Math.abs(fPane.el.scrollTop) >= 0.5) {
            fPane.ignoreScrollUntil = performance.now() + lockMs;
            fPane.el.scrollTop = 0;
          }
        }
        return true;
      }

      var targetEl = slot.querySelector(PARA_SELECTOR) || slot;
      var paneRect = pane.el.getBoundingClientRect();
      var targetRect = targetEl.getBoundingClientRect();
      var maxScroll = Math.max(0, pane.el.scrollHeight - pane.el.clientHeight);
      var desiredY = paneRect.top + pane.el.clientHeight * readingRatio - 2;
      var nextTop = clamp(pane.el.scrollTop + (targetRect.top - desiredY), 0, maxScroll);

      pane.ignoreScrollUntil = 0;
      pane.el.scrollTop = nextTop;
      pane.selfEchoTop = pane.el.scrollTop;
      pane.selfEchoUntil = performance.now() + lockMs;

      var anchor = captureAnchor(pane);
      if (anchor) {
        lastAnchor = anchor;
        onAnchorChange(anchor);
      }
      for (var i = 0; i < panes.length; i++) {
        var f = panes[i];
        if (f.id === pane.id) continue;
        if (anchor) applyAnchorToPane(f, anchor, false);
      }
      return true;
    }

    function setCurrentPage(n) {
      if (n >= 1) currentPageN = n;
    }

    function getCurrentPage() {
      return currentPageN;
    }

    function setLeader(id) {
      if (paneById[id]) activeLeaderId = id;
    }

    function setPaused(val) {
      paused = !!val;
    }

    function setResizeSuppressed(val) {
      resizeSuppressed = !!val;
      if (!resizeSuppressed) {
        for (var i = 0; i < panes.length; i++) {
          var p = panes[i];
          if (p.el) {
            p.lastW = p.el.clientWidth;
            p.lastH = p.el.clientHeight;
          }
          if (p.contentEl) {
            p.lastContentH = p.contentEl.scrollHeight;
          }
        }
      }
    }

    function destroy() {
      destroyed = true;
      if (resizeObserver) resizeObserver.disconnect();
      for (var i = 0; i < panes.length; i++) {
        var p = panes[i];
        for (var j = 0; j < p.listeners.length; j++) {
          var l = p.listeners[j];
          p.el.removeEventListener(l[0], l[1], l[2]);
        }
      }
      panes = [];
      paneById = {};
    }

    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        if (!destroyed) resyncLayout();
      });
    }

    return {
      registerPane: registerPane,
      resync: resync,
      syncFromPane: syncFromPane,
      preserveAnchorAndRun: preserveAnchorAndRun,
      scrollToPage: scrollToPage,
      setCurrentPage: setCurrentPage,
      getCurrentPage: getCurrentPage,
      getLastAnchor: function () { return lastAnchor; },
      setLeader: setLeader,
      setPaused: setPaused,
      setResizeSuppressed: setResizeSuppressed,
      destroy: destroy
    };
  }

  return { create: createSyncController };
})();
