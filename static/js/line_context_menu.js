/**
 * line_context_menu.js
 * Right-click menu on review line text: "Flag" (wraps the selection or word in ??..??)
 * and "Review PDF & Edit" (opens the micro view on that line).
 * Shift+right-click keeps the native browser menu. External file only (CSP).
 */
window.LineContextMenu = (function () {
  'use strict';

  // ---------- pure helpers (exported for tests) ----------
  function computeMenuPosition(x, y, w, h, vw, vh, m) {
    m = (m === undefined) ? 8 : m;
    let left = x;
    let top = y;
    if (left + w + m > vw) left = x - w;
    if (top + h + m > vh) top = y - h;
    left = Math.max(m, left);
    top = Math.max(m, top);
    return { left, top };
  }

  function classifyTarget(o) {
    if (o.multiLine) return 'multi-line';
    if (o.insideFlag) return 'inside-flag';
    if (o.collapsed && !o.hasWordAtCaret) return 'empty';
    return o.collapsed ? 'word' : 'selection';
  }

  function computeMenuState(o) {
    const lock = o.lockInfo || { isEditable: true, status: 'available', claimant: '' };
    const target = o.target;
    const flag = {
      enabled: true,
      label: target === 'inside-flag' ? 'Remove flag' : '🚩 Flag',
      reason: '',
      note: ''
    };
    if (!lock.isEditable) {
      flag.enabled = false;
      if (lock.status === 'merged') flag.reason = 'Page merged: read-only';
      else if (lock.status === 'completed') flag.reason = 'Completed by ' + (lock.claimant || 'another reviewer');
      else flag.reason = 'Page claimed by ' + (lock.claimant || 'another reviewer') + ': claim it to flag';
    } else if (o.microOpen) {
      flag.enabled = false;
      flag.reason = 'Close the line inspector first (Esc)';
    } else if (target === 'multi-line') {
      flag.enabled = false;
      flag.reason = 'Select within one line';
    } else if (target === 'empty') {
      flag.enabled = false;
      flag.reason = 'Right-click a word or select text';
    } else if (lock.status === 'available' || !lock.claimant) {
      flag.note = 'This will claim the page for you';
    }
    return { flag, review: { enabled: true, label: '🖼️ Review PDF & Edit' } };
  }

  // ---------- DOM ----------
  let menuEl = null;
  let toastEl = null;
  let toastTimer = null;
  let saved = null;
  let items = [];

  function isOpen() { return !!menuEl && !menuEl.hidden; }

  function mk(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function build() {
    if (menuEl) return;
    menuEl = mk('div');
    menuEl.id = 'lineContextMenu';
    menuEl.setAttribute('role', 'menu');
    menuEl.setAttribute('dir', 'ltr');
    menuEl.hidden = true;

    const flagBtn = mk('button');
    flagBtn.type = 'button';
    flagBtn.id = 'lcmFlag';
    flagBtn.setAttribute('role', 'menuitem');
    flagBtn.appendChild(mk('span', 'lcm-label'));
    flagBtn.appendChild(mk('small', 'lcm-hint', '⌘/ · Ctrl+/'));
    const flagReason = mk('small', 'lcm-reason');
    flagReason.id = 'lcmFlagReason';
    flagBtn.appendChild(flagReason);
    flagBtn.setAttribute('aria-describedby', 'lcmFlagReason');

    const revBtn = mk('button');
    revBtn.type = 'button';
    revBtn.id = 'lcmReview';
    revBtn.setAttribute('role', 'menuitem');
    revBtn.appendChild(mk('span', 'lcm-label'));
    revBtn.appendChild(mk('small', 'lcm-hint', 'Double-click'));

    menuEl.appendChild(flagBtn);
    menuEl.appendChild(revBtn);
    document.body.appendChild(menuEl);
    items = [flagBtn, revBtn];

    items.forEach((b) => {
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => activate(b));
    });
    menuEl.addEventListener('keydown', onMenuKeydown);

    toastEl = mk('div');
    toastEl.id = 'lineContextToast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    toastEl.hidden = true;
    document.body.appendChild(toastEl);
  }

  function toast(msg) {
    build();
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
  }

  function enabledItems() {
    return items.filter((b) => b.getAttribute('aria-disabled') !== 'true');
  }

  function close(restore) {
    if (!menuEl || menuEl.hidden) { return; }
    menuEl.hidden = true;
    const ctx = saved;
    if (restore && ctx && ctx.textDiv && ctx.textDiv.isConnected) {
      restoreSelection(ctx);
    }
  }

  function restoreSelection(ctx) {
    try {
      ctx.textDiv.focus({ preventScroll: true });
      if (ctx.range && ctx.range.startContainer.isConnected) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(ctx.range);
      }
    } catch (e) { /* ignore */ }
  }

  function lockInfo() {
    const pid = window.MacroView && window.MacroView.getCurrentPageId();
    if (window.ReviewSync && typeof window.ReviewSync.getPageLockInfo === 'function') {
      return window.ReviewSync.getPageLockInfo(pid);
    }
    return { isEditable: true, status: 'available', claimant: '' };
  }

  function openAt(x, y, ctx) {
    build();
    saved = ctx;
    const st = computeMenuState({
      lockInfo: lockInfo(),
      microOpen: !!(window.MicroView && window.MicroView.isOpen && window.MicroView.isOpen()),
      target: ctx.target
    });
    const fb = items[0];
    fb.querySelector('.lcm-label').textContent = st.flag.label;
    fb.setAttribute('aria-disabled', st.flag.enabled ? 'false' : 'true');
    fb.querySelector('.lcm-reason').textContent = st.flag.enabled ? st.flag.note : st.flag.reason;
    items[1].querySelector('.lcm-label').textContent = st.review.label;
    items[1].setAttribute('aria-disabled', 'false');

    menuEl.hidden = false;
    menuEl.style.left = '0px';
    menuEl.style.top = '0px';
    const r = menuEl.getBoundingClientRect();
    const pos = computeMenuPosition(x, y, r.width, r.height, window.innerWidth, window.innerHeight);
    menuEl.style.left = pos.left + 'px';
    menuEl.style.top = pos.top + 'px';
    const first = enabledItems()[0];
    if (first) first.focus({ preventScroll: true });
  }

  function activate(btn) {
    if (btn.getAttribute('aria-disabled') === 'true') return;
    const ctx = saved;
    menuEl.hidden = true;
    if (!ctx) return;
    if (btn === items[0]) doFlag(ctx); else doReview(ctx);
  }

  function doFlag(ctx) {
    if (!ctx.textDiv.isConnected || !ctx.range.startContainer.isConnected) {
      toast('Line changed, try again');
      return;
    }
    restoreSelection(ctx);
    const res = window.MacroView.applySelectionAction('??');
    if (!res || !res.ok) {
      toast(res && res.reason === 'locked' ? 'Not saved: page is locked' : 'Could not flag this text');
    } else if (res.saved === false) {
      toast('Not saved: page is locked');
    } else if (res.changed === false) {
      toast('Nothing to flag');
    } else if (res.action === 'removed' || (res.action === undefined && !res.flagged)) {
      toast('Flag removed.');
    } else {
      toast('Flagged — it now appears in the Editorial Hub under Flagged Open Questions.');
    }
  }

  function doReview(ctx) {
    if (window.MicroView && window.MicroView.isOpen && window.MicroView.isOpen()) {
      window.MicroView.close(true);
    }
    if (ctx.row && ctx.row.isConnected) ctx.row.scrollIntoView({ block: 'center' });
    if (window.MicroView) window.MicroView.open(ctx.idx);
  }

  function onMenuKeydown(e) {
    const en = enabledItems();
    const cur = en.indexOf(document.activeElement);
    let handled = true;
    if (e.key === 'ArrowDown') {
      if (en.length) en[(cur + 1) % en.length].focus();
    } else if (e.key === 'ArrowUp') {
      if (en.length) en[(cur - 1 + en.length) % en.length].focus();
    } else if (e.key === 'Home') {
      if (en.length) en[0].focus();
    } else if (e.key === 'End') {
      if (en.length) en[en.length - 1].focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      activate(document.activeElement);
    } else if (e.key === 'Escape') {
      close(true);
    } else if (e.key === 'Tab') {
      close(false);
      handled = false;
    } else {
      handled = false;
    }
    if (handled) { e.preventDefault(); }
    e.stopPropagation();
  }

  // ---------- target resolution ----------
  function caretAtPoint(x, y) {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p && p.offsetNode) {
        const r = document.createRange();
        r.setStart(p.offsetNode, p.offset);
        r.collapse(true);
        return r;
      }
    }
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    return null;
  }

  function pointInRects(range, x, y) {
    const rects = range.getClientRects();
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
    return false;
  }

  function lineTextOf(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return el && el.closest ? el.closest('.line-text') : null;
  }

  function flagOf(node, textDiv) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    const f = el && el.closest ? el.closest('.flagged-word') : null;
    return f && textDiv.contains(f) ? f : null;
  }

  // True when the range starts/ends in a flag, sits inside one, points at one through an
  // element container offset (e.g. startContainer = .line-text DIV after flagging), or covers one.
  function rangeTouchesFlag(range, textDiv) {
    const sc = range.startContainer;
    const ec = range.endContainer;
    if (flagOf(sc, textDiv) || flagOf(ec, textDiv) || flagOf(range.commonAncestorContainer, textDiv)) return true;
    if (sc.nodeType === 1 && sc.childNodes && flagOf(sc.childNodes[range.startOffset], textDiv)) return true;
    if (ec.nodeType === 1 && ec.childNodes && range.endOffset > 0 &&
        flagOf(ec.childNodes[range.endOffset - 1], textDiv)) return true;
    if (textDiv.querySelectorAll && typeof range.intersectsNode === 'function') {
      const flags = textDiv.querySelectorAll('.flagged-word');
      for (let i = 0; i < flags.length; i++) {
        if (range.intersectsNode(flags[i])) return true;
      }
    }
    return false;
  }

  // pt = optional {x, y} pointer position: a collapsed caret next to a word only counts as
  // "on the word" when the pointer is really over the word (so a click in a gap is 'empty').
  function analyse(range, textDiv, pt) {
    const startDiv = lineTextOf(range.startContainer);
    const endDiv = lineTextOf(range.endContainer);
    const multiLine = !startDiv || !endDiv || startDiv !== endDiv || startDiv !== textDiv;
    const collapsed = range.collapsed;
    let hasWordAtCaret = false;
    if (collapsed && range.startContainer.nodeType === 3) {
      const t = range.startContainer.nodeValue || '';
      const o = range.startOffset;
      hasWordAtCaret = (o > 0 && !/\s/.test(t[o - 1])) || (o < t.length && !/\s/.test(t[o]));
      if (hasWordAtCaret && pt && typeof document !== 'undefined' && document.createRange) {
        let a = o;
        let b = o;
        while (a > 0 && !/\s/.test(t[a - 1])) a--;
        while (b < t.length && !/\s/.test(t[b])) b++;
        const wr = document.createRange();
        wr.setStart(range.startContainer, a);
        wr.setEnd(range.startContainer, b);
        if (wr.getClientRects && wr.getClientRects().length && !pointInRects(wr, pt.x, pt.y)) hasWordAtCaret = false;
      }
    }
    const insideFlag = rangeTouchesFlag(range, textDiv);
    // whitespace-only selection: nothing to flag
    if (!collapsed && !insideFlag && !multiLine && range.toString().trim() === '') return 'empty';
    return classifyTarget({ multiLine, collapsed, hasWordAtCaret, insideFlag });
  }

  function guideOpen() {
    return !!document.querySelector('.guide-modal.open');
  }

  function onContextMenu(e) {
    if (e.shiftKey || guideOpen()) return;
    const textDiv = e.target.closest ? e.target.closest('.line-text') : null;
    if (!textDiv) return;
    const row = textDiv.closest('.review-line-row');
    if (!row) return;
    const idx = parseInt(row.dataset.lineIdx, 10);
    if (isNaN(idx)) return;

    const sel = window.getSelection();
    let range = null;
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const r = sel.getRangeAt(0);
      if (pointInRects(r, e.clientX, e.clientY)) range = r.cloneRange();
    }
    if (!range) {
      range = caretAtPoint(e.clientX, e.clientY);
      if (!range || !textDiv.contains(range.startContainer)) {
        range = document.createRange();
        range.selectNodeContents(textDiv);
        range.collapse(true);
      }
      textDiv.focus({ preventScroll: true });
      sel.removeAllRanges();
      sel.addRange(range);
      range = range.cloneRange();
    }
    e.preventDefault();
    openAt(e.clientX, e.clientY, { range, idx, row, textDiv, target: analyse(range, textDiv, { x: e.clientX, y: e.clientY }) });
  }

  function onKeydownGlobal(e) {
    if (isOpen()) return;
    const isKey = (e.key === 'ContextMenu') || (e.key === 'F10' && e.shiftKey);
    if (!isKey) return;
    const ae = document.activeElement;
    const textDiv = ae && ae.classList && ae.classList.contains('line-text') ? ae : null;
    if (!textDiv || guideOpen()) return;
    const row = textDiv.closest('.review-line-row');
    if (!row) return;
    const idx = parseInt(row.dataset.lineIdx, 10);
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !textDiv.contains(sel.anchorNode)) return;
    const range = sel.getRangeAt(0).cloneRange();
    let rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height && !rect.left && !rect.top)) {
      const rs = range.getClientRects();
      rect = rs.length ? rs[0] : textDiv.getBoundingClientRect();
    }
    e.preventDefault();
    e.stopPropagation();
    openAt(rect.left, rect.bottom, { range, idx, row, textDiv, target: analyse(range, textDiv) });
  }

  function init() {
    build();
    const container = document.getElementById('linesContainer');
    if (container) container.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('keydown', onKeydownGlobal, true);
    document.addEventListener('pointerdown', (e) => {
      if (isOpen() && !menuEl.contains(e.target)) close(false);
    }, true);
    window.addEventListener('blur', () => close(false));
    window.addEventListener('resize', () => close(false));
    window.addEventListener('scroll', () => close(false), true);
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('DOMContentLoaded', init);
  }

  return { init, close, computeMenuPosition, classifyTarget, computeMenuState, isOpen, analyse };
})();
