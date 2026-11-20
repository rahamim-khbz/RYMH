// Full-screen horizontal swipe pager for narrow screens (< 860px).
// Screen 0 ('text'): stacked Hebrew/English paragraph stream.
// Screen 1 ('scan'): full-screen manuscript scan.
window.ReaderMobilePager = (function () {
  'use strict';

  function createMobilePager(options) {
    var opts = options || {};
    var stageEl = opts.stageEl;
    var trackEl = opts.trackEl;
    var textPaneEl = opts.textPaneEl;
    var scanPaneEl = opts.scanPaneEl;
    var textTabBtn = opts.textTabBtn;
    var scanTabBtn = opts.scanTabBtn;
    var isBlocked = typeof opts.isBlocked === 'function' ? opts.isBlocked : function () { return false; };
    var onScreenChange = typeof opts.onScreenChange === 'function' ? opts.onScreenChange : function () {};
    var onSwipeStateChange = typeof opts.onSwipeStateChange === 'function' ? opts.onSwipeStateChange : function () {};

    var mq = window.matchMedia('(max-width: 859px)');
    var active = 'text'; // 'text' | 'scan'
    var pointerId = null;
    var startX = 0;
    var startY = 0;
    var lastX = 0;
    var axis = null; // null | 'x' | 'y'
    var samples = [];

    function isNarrow() {
      return mq.matches;
    }

    function applyScreenVisual(instant) {
      if (!trackEl) return;
      if (!isNarrow()) {
        trackEl.style.transform = '';
        trackEl.classList.remove('is-dragging');
        if (textPaneEl) {
          textPaneEl.removeAttribute('aria-hidden');
          textPaneEl.inert = false;
        }
        if (scanPaneEl) {
          scanPaneEl.removeAttribute('aria-hidden');
          scanPaneEl.inert = false;
        }
        return;
      }

      if (instant) trackEl.classList.add('is-dragging');
      trackEl.style.transform = active === 'scan' ? 'translate3d(0%, 0, 0)' : 'translate3d(-50%, 0, 0)';
      if (instant) {
        void trackEl.offsetWidth;
        trackEl.classList.remove('is-dragging');
      }

      if (textPaneEl) {
        var textHidden = active !== 'text';
        if (textHidden) textPaneEl.setAttribute('aria-hidden', 'true');
        else textPaneEl.removeAttribute('aria-hidden');
        textPaneEl.inert = textHidden;
      }
      if (scanPaneEl) {
        var scanHidden = active !== 'scan';
        if (scanHidden) scanPaneEl.setAttribute('aria-hidden', 'true');
        else scanPaneEl.removeAttribute('aria-hidden');
        scanPaneEl.inert = scanHidden;
      }

      if (textTabBtn) {
        textTabBtn.setAttribute('aria-pressed', active === 'text' ? 'true' : 'false');
      }
      if (scanTabBtn) {
        scanTabBtn.setAttribute('aria-pressed', active === 'scan' ? 'true' : 'false');
      }
      if (stageEl) {
        stageEl.setAttribute('data-mobile-screen', active);
      }
    }

    function goTo(screen, optsArg) {
      var o = optsArg || {};
      var target = screen === 'scan' ? 'scan' : 'text';
      var prev = active;
      active = target;
      applyScreenVisual(!!o.instant);
      if (prev !== target || o.forceNotify) {
        onScreenChange(target, prev);
      }
      return target;
    }

    function toggle() {
      return goTo(active === 'text' ? 'scan' : 'text');
    }

    function recordSample(x) {
      var now = performance.now();
      samples.push({ x: x, t: now });
      while (samples.length > 1 && now - samples[0].t > 100) {
        samples.shift();
      }
    }

    function velocityX() {
      if (samples.length < 2) return 0;
      var first = samples[0];
      var last = samples[samples.length - 1];
      var dt = last.t - first.t;
      if (dt <= 0) return 0;
      return (last.x - first.x) / dt; // px/ms
    }

    function resetPointer() {
      if (axis === 'x') {
        if (trackEl) trackEl.classList.remove('is-dragging');
        onSwipeStateChange(false);
      }
      pointerId = null;
      axis = null;
      samples = [];
    }

    if (stageEl && trackEl) {
      stageEl.addEventListener('pointerdown', function (e) {
        if (!isNarrow() || isBlocked()) return;
        if (pointerId !== null) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (e.target && e.target.closest && e.target.closest('button, a, input, select, dialog')) return;
        if (e.clientX < 12 || e.clientX > window.innerWidth - 12) return;

        pointerId = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        lastX = e.clientX;
        axis = null;
        samples = [{ x: e.clientX, t: performance.now() }];
      });

      stageEl.addEventListener('pointermove', function (e) {
        if (e.pointerId !== pointerId || !isNarrow()) return;
        var dx = e.clientX - startX;
        var dy = e.clientY - startY;

        if (!axis) {
          if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) {
            axis = 'y';
            return;
          }
          if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.25) {
            axis = 'x';
            trackEl.classList.add('is-dragging');
            onSwipeStateChange(true);
            try { stageEl.setPointerCapture(e.pointerId); } catch (err) {}
          } else {
            return;
          }
        }

        if (axis !== 'x') return;
        lastX = e.clientX;
        recordSample(e.clientX);

        var width = stageEl.clientWidth || window.innerWidth || 390;
        var basePct = active === 'scan' ? 0 : -50;
        var clampedDx = dx;
        if (active === 'text') {
          if (dx < 0) clampedDx = dx * 0.2;
          else if (dx > width) clampedDx = width + (dx - width) * 0.2;
        } else {
          if (dx > 0) clampedDx = dx * 0.2;
          else if (dx < -width) clampedDx = -width + (dx + width) * 0.2;
        }
        trackEl.style.transform = 'translate3d(calc(' + basePct + '% + ' + clampedDx.toFixed(1) + 'px), 0, 0)';
      });

      var onPointerEnd = function (e) {
        if (e.pointerId !== pointerId) return;
        var wasX = axis === 'x';
        var dx = lastX - startX;
        var vx = velocityX();
        var width = stageEl.clientWidth || window.innerWidth || 390;
        try { stageEl.releasePointerCapture(e.pointerId); } catch (err) {}
        resetPointer();

        if (!wasX) return;
        if (active === 'text' && (dx > width * 0.25 || vx > 0.35)) {
          goTo('scan');
        } else if (active === 'scan' && (dx < -width * 0.25 || vx < -0.35)) {
          goTo('text');
        } else {
          applyScreenVisual(false);
        }
      };

      stageEl.addEventListener('pointerup', onPointerEnd);
      stageEl.addEventListener('pointercancel', onPointerEnd);
    }

    if (textTabBtn) {
      textTabBtn.addEventListener('click', function () { goTo('text'); });
    }
    if (scanTabBtn) {
      scanTabBtn.addEventListener('click', function () { goTo('scan'); });
    }

    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', function () { applyScreenVisual(true); });
    } else if (typeof mq.addListener === 'function') {
      mq.addListener(function () { applyScreenVisual(true); });
    }

    applyScreenVisual(true);

    return {
      goTo: goTo,
      toggle: toggle,
      getScreen: function () { return active; },
      isNarrow: isNarrow,
      refresh: function () { applyScreenVisual(true); }
    };
  }

  return { create: createMobilePager };
})();
