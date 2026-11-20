// Accessible bottom-sheet Footnote Drawer used everywhere (desktop & mobile).
// Renders notes[].paragraphs (including multi-paragraph pp. 23 & 82), handles
// nested `within` notes and page-spanning `continued` notes, manages `inert`
// background and focus restoration, and implements Pointer Events swipe-to-dismiss
// with the iOS scrollTop === 0 rule.
// Strict CSP-compliant: zero innerHTML, zero inline scripts/handlers.
(function () {
  'use strict';
  // UI language (ui_prefs.js): note text stays Hebrew; only the interface switches.
  var IS_EN = typeof window !== 'undefined' && window.RYMH_LANG === 'en';
  function L(he, en) { return IS_EN ? en : he; }

  var FINAL_MAP = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function normalizePageId(page) {
    if (!page) return '';
    if (typeof page === 'object' && page.page) return String(page.page);
    var s = String(page).trim();
    if (/^page-\d{2}$/.test(s)) return s;
    var m = /^page-(\d+)$/.exec(s) || /^(\d+)$/.exec(s);
    if (m) return 'page-' + pad(parseInt(m[1], 10));
    return s;
  }

  function normMarker(m) {
    return String(m || '')
      .replace(/["\u05f4'\u05f3]/g, '')
      .replace(/[ךםןףץ]/g, function (ch) { return FINAL_MAP[ch] || ch; })
      .trim();
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function isThenable(val) {
    return Boolean(val && typeof val.then === 'function');
  }

  function prefersReducedMotion() {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // ---- Module state ----
  var cfg = {
    mountEl: null,
    inertEl: null,
    getPageData: null,
    onHighlightLine: null,
    onFlagNote: null
  };

  var backdropEl = null;
  var drawerEl = null;
  var headerEl = null;
  var handleEl = null;
  var titleEl = null;
  var metaEl = null;
  var backBtn = null;
  var expandBtn = null;
  var flagBtn = null;
  var closeBtn = null;
  var bodyEl = null;
  var footerEl = null;

  var isOpenFlag = false;
  var isExpandedFlag = false;
  var openSeq = 0;
  var initialTriggerEl = null;
  var inertSnapshot = [];
  var historyStack = []; // [{ pageId, noteIdx }]
  var activeView = null; // { pageData, noteIdx, note }
  var activeHighlight = null; // { pageId, lineId }
  var activeDrag = null;
  var docListenersBound = false;

  function resolveNoteEntry(pageData, opts) {
    var notes = (pageData && Array.isArray(pageData.notes)) ? pageData.notes : [];
    if (!notes.length) return null;

    if (opts.noteIndex != null && opts.noteIndex !== '') {
      var idx = Number(opts.noteIndex);
      if (idx >= 0 && idx < notes.length) return { note: notes[idx], idx: idx };
    }
    if (opts.noteId) {
      var wantId = String(opts.noteId);
      for (var i = 0; i < notes.length; i++) {
        if (notes[i].id === wantId || (notes[i].line_ids && notes[i].line_ids.indexOf(wantId) !== -1)) {
          return { note: notes[i], idx: i };
        }
      }
    }
    if (opts.marker) {
      var wantM = normMarker(opts.marker);
      for (var j = 0; j < notes.length; j++) {
        if (normMarker(notes[j].marker) === wantM) {
          return { note: notes[j], idx: j };
        }
      }
    }
    return null;
  }

  function fetchPage(page) {
    if (page && typeof page === 'object' && Array.isArray(page.notes)) return page;
    var pid = normalizePageId(page);
    if (!pid || typeof cfg.getPageData !== 'function') return null;
    return cfg.getPageData(pid);
  }

  // ---- Text rendering (**bold** + nested `within` triggers) ----
  function appendTextWithNested(parent, text, pageData, nestedChildren) {
    if (!text) return;
    if (!nestedChildren || !nestedChildren.length) {
      parent.appendChild(document.createTextNode(text));
      return;
    }

    var childByNorm = Object.create(null);
    for (var c = 0; c < nestedChildren.length; c++) {
      var nm = normMarker(nestedChildren[c].note.marker);
      if (nm && !childByNorm[nm]) childByNorm[nm] = nestedChildren[c];
    }

    var re = /\(([^()]{1,6})\)/g;
    var lastIndex = 0;
    var match;
    while ((match = re.exec(text)) !== null) {
      var tokNorm = normMarker(match[1]);
      var target = childByNorm[tokNorm];
      if (!target) continue;

      if (match.index > lastIndex) {
        parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      var btn = el('button', 'fn-ref fn-ref-nested', match[0]);
      btn.type = 'button';
      btn.setAttribute('data-fn-trigger', 'true');
      btn.setAttribute('data-page', pageData.page);
      btn.setAttribute('data-n', String(pageData.n));
      btn.setAttribute('data-note-idx', String(target.idx));
      if (target.note.id) btn.setAttribute('data-note-id', target.note.id);
      btn.setAttribute('data-marker', target.note.marker || match[1]);
      btn.setAttribute('aria-label', L('הערה פנימית ', 'Inner note ') + (target.note.marker || match[1]));
      (function (capturedIdx) {
        btn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          navigateToNote(pageData.page, capturedIdx, true);
        });
      })(target.idx);
      parent.appendChild(btn);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      parent.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function appendRichNoteText(parent, text, pageData, nestedChildren) {
    var parts = String(text || '').split(/\*\*(.+?)\*\*/g);
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (i % 2 === 1) {
        var b = document.createElement('b');
        appendTextWithNested(b, parts[i], pageData, nestedChildren);
        parent.appendChild(b);
      } else {
        appendTextWithNested(parent, parts[i], pageData, nestedChildren);
      }
    }
  }

  // ---- Background inert helpers ----
  function collectInertTargets() {
    var targets = [];
    var seen = [];
    function add(node) {
      if (!node || node === drawerEl || node === backdropEl) return;
      if (node.nodeType !== 1) return;
      var tag = node.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK') return;
      if (node.contains(drawerEl)) return;
      if (seen.indexOf(node) === -1) {
        seen.push(node);
        targets.push(node);
      }
    }

    if (cfg.inertEl) {
      if (typeof cfg.inertEl.length === 'number' && !cfg.inertEl.nodeType) {
        for (var i = 0; i < cfg.inertEl.length; i++) add(cfg.inertEl[i]);
      } else {
        add(cfg.inertEl);
      }
    }
    if (!targets.length && document.body) {
      var children = document.body.children;
      for (var k = 0; k < children.length; k++) add(children[k]);
    }
    return targets;
  }

  function applyBackgroundInert() {
    restoreBackgroundInert();
    var targets = collectInertTargets();
    inertSnapshot = [];
    for (var i = 0; i < targets.length; i++) {
      var node = targets[i];
      inertSnapshot.push({ el: node, prevInert: Boolean(node.inert) });
      node.inert = true;
    }
  }

  function restoreBackgroundInert() {
    for (var i = 0; i < inertSnapshot.length; i++) {
      var rec = inertSnapshot[i];
      if (rec.el && rec.el.isConnected) {
        rec.el.inert = rec.prevInert;
      }
    }
    inertSnapshot = [];
  }

  // ---- Expand toggle for long notes ----
  function setExpanded(expanded) {
    isExpandedFlag = Boolean(expanded);
    drawerEl.classList.toggle('is-expanded', isExpandedFlag);
    expandBtn.setAttribute('aria-expanded', isExpandedFlag ? 'true' : 'false');
    expandBtn.textContent = isExpandedFlag ? L('כווץ', 'Collapse') : L('הרחב', 'Expand');
    expandBtn.setAttribute('aria-label', isExpandedFlag ? L('כווץ חלונית הערה', 'Collapse note panel') : L('הרחב חלונית הערה', 'Expand note panel'));
  }

  function refreshExpandVisibility(note) {
    if (!note) {
      expandBtn.hidden = true;
      return;
    }
    var paraCount = Array.isArray(note.paragraphs) ? note.paragraphs.length : 1;
    var textLen = (note.t || '').length;
    var overflows = bodyEl.scrollHeight > bodyEl.clientHeight + 6;
    var isLong = paraCount > 1 || textLen > 350 || overflows;
    expandBtn.hidden = !isLong;
  }

  // ---- Continuation footer ----
  function addContinuationButton(targetPageData, targetIdx, label) {
    var btn = el('button', 'fn-btn fn-nav-btn', label);
    btn.type = 'button';
    btn.addEventListener('click', function () {
      navigateToNote(targetPageData.page, targetIdx, true);
    });
    footerEl.appendChild(btn);
    footerEl.hidden = false;
  }

  function populateContinuationLinks(pageData, note, seqAtStart) {
    footerEl.textContent = '';
    footerEl.hidden = true;
    var wantM = normMarker(note.marker);
    if (!wantM || note.within) return;

    function checkNeighbor(neighborPageN, expectContinued, labelBuilder) {
      if (neighborPageN < 1) return;
      var res = fetchPage(neighborPageN);
      if (!res) return;
      function handleData(ndata) {
        if (!isOpenFlag || seqAtStart !== openSeq || !ndata || !Array.isArray(ndata.notes)) return;
        for (var i = 0; i < ndata.notes.length; i++) {
          var cand = ndata.notes[i];
          if (cand.within) continue;
          if (normMarker(cand.marker) === wantM && Boolean(cand.continued) === expectContinued) {
            addContinuationButton(ndata, i, labelBuilder(ndata));
            break;
          }
        }
      }
      if (isThenable(res)) res.then(handleData, function () {});
      else handleData(res);
    }

    if (note.continued && pageData.n > 1) {
      checkNeighbor(pageData.n - 1, false, function (pd) {
        return L('→ תחילת הערה (' + note.marker + ') בעמוד ' + pd.n, '→ Start of note (' + note.marker + ') on page ' + pd.n);
      });
    }
    if (pageData.n > 0) {
      checkNeighbor(pageData.n + 1, true, function (pd) {
        return L('← המשך הערה (' + note.marker + ') בעמוד ' + pd.n, '← Note (' + note.marker + ') continues on page ' + pd.n);
      });
    }
  }

  function clearActiveHighlight() {
    if (activeHighlight && typeof cfg.onHighlightLine === 'function') {
      try {
        cfg.onHighlightLine(activeHighlight.pageId, activeHighlight.lineId, false);
      } catch (_) {}
    }
    activeHighlight = null;
  }

  // ---- Render note inside drawer ----
  function renderNote(pageData, noteIdx) {
    clearActiveHighlight();
    var note = pageData && pageData.notes && pageData.notes[noteIdx];
    if (!note) {
      bodyEl.textContent = '';
      bodyEl.appendChild(el('p', 'fn-empty', 'ההערה לא נמצאה.'));
      footerEl.textContent = '';
      footerEl.hidden = true;
      expandBtn.hidden = true;
      flagBtn.hidden = true;
      activeView = null;
      return;
    }

    activeView = { pageData: pageData, noteIdx: noteIdx, note: note };
    setExpanded(false);

    titleEl.textContent = note.marker ? (L('הערה', 'Note') + ' (' + note.marker + ')') : L('הערה', 'Note');
    var metaParts = [L('עמוד ', 'Page ') + pageData.n];
    if (note.within) metaParts.push(L('בתוך', 'within') + ' (' + note.within + ')');
    else if (note.continued) metaParts.push(L('המשך', 'continued'));
    metaEl.textContent = metaParts.join(' · ');

    backBtn.hidden = historyStack.length === 0;
    flagBtn.hidden = typeof cfg.onFlagNote !== 'function';

    // Nested child notes whose `within` matches this note's marker
    var nestedChildren = [];
    var noteNorm = normMarker(note.marker);
    if (noteNorm && !note.within) {
      for (var i = 0; i < pageData.notes.length; i++) {
        var cand = pageData.notes[i];
        if (cand.within && normMarker(cand.within) === noteNorm) {
          nestedChildren.push({ note: cand, idx: i });
        }
      }
    }

    bodyEl.textContent = '';
    var paras = Array.isArray(note.paragraphs) && note.paragraphs.length
      ? note.paragraphs
      : [{ pid: pageData.page + ':n' + noteIdx + ':0', cont: Boolean(note.continued), lines: [{ id: note.id || '', t: note.t || '' }] }];

    for (var p = 0; p < paras.length; p++) {
      var para = paras[p];
      var pEl = el('p', 'fn-para' + (para.cont ? ' cont' : ''));
      if (para.pid) pEl.setAttribute('data-pid', para.pid);

      var lines = Array.isArray(para.lines) ? para.lines : [];
      for (var l = 0; l < lines.length; l++) {
        if (l > 0) pEl.appendChild(document.createTextNode(' '));
        var line = lines[l];
        var span = el('span', 'rline fn-line');
        span.setAttribute('data-page', pageData.page);
        if (para.pid) span.setAttribute('data-para', para.pid);
        if (line.id) span.setAttribute('data-line-id', line.id);
        span.setAttribute('data-line-idx', String(l));
        appendRichNoteText(span, line.t || '', pageData, nestedChildren);
        pEl.appendChild(span);
      }
      bodyEl.appendChild(pEl);
    }

    bodyEl.scrollTop = 0;
    populateContinuationLinks(pageData, note, openSeq);
    refreshExpandVisibility(note);
    if (typeof requestAnimationFrame === 'function') {
      var seqNow = openSeq;
      requestAnimationFrame(function () {
        if (isOpenFlag && seqNow === openSeq && activeView && activeView.note === note) {
          refreshExpandVisibility(note);
        }
      });
    }

    if (typeof cfg.onHighlightLine === 'function' && note.ref && note.ref.line_id) {
      activeHighlight = { pageId: pageData.page, lineId: note.ref.line_id };
      try {
        cfg.onHighlightLine(pageData.page, note.ref.line_id, true);
      } catch (_) {}
    }
  }

  function navigateToNote(page, noteIdxOrOpts, pushHistory) {
    if (pushHistory && activeView) {
      historyStack.push({ pageId: activeView.pageData.page, noteIdx: activeView.noteIdx });
    }
    var mySeq = openSeq;
    var res = fetchPage(page);
    var opts = (typeof noteIdxOrOpts === 'number') ? { noteIndex: noteIdxOrOpts } : (noteIdxOrOpts || {});

    function applyPageData(pageData) {
      if (!isOpenFlag || mySeq !== openSeq) return;
      var found = resolveNoteEntry(pageData, opts);
      if (!found) {
        renderNote(null, -1);
        return;
      }
      renderNote(pageData, found.idx);
    }

    if (!res) {
      renderNote(null, -1);
      return;
    }
    if (isThenable(res)) {
      bodyEl.textContent = '';
      bodyEl.appendChild(el('p', 'fn-loading', 'טוען…'));
      res.then(applyPageData, function () {
        if (isOpenFlag && mySeq === openSeq) renderNote(null, -1);
      });
    } else {
      applyPageData(res);
    }
  }

  // ---- Keyboard focus trap + Esc ----
  function getFocusableElements() {
    var nodes = drawerEl.querySelectorAll(
      'button:not([disabled]):not([hidden]), a[href]:not([hidden]), [tabindex="0"]:not([hidden])'
    );
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].offsetParent !== null || nodes[i] === bodyEl) out.push(nodes[i]);
    }
    return out;
  }

  function onDocumentKeyDown(ev) {
    if (!isOpenFlag) return;
    if (ev.key === 'Escape' || ev.key === 'Esc') {
      ev.preventDefault();
      ev.stopPropagation();
      close();
      return;
    }
    if (ev.key === 'Tab') {
      var list = getFocusableElements();
      if (!list.length) {
        ev.preventDefault();
        drawerEl.focus({ preventScroll: true });
        return;
      }
      var first = list[0];
      var last = list[list.length - 1];
      var cur = document.activeElement;
      if (ev.shiftKey) {
        if (cur === first || cur === drawerEl || !drawerEl.contains(cur)) {
          ev.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (cur === last || !drawerEl.contains(cur)) {
        ev.preventDefault();
        first.focus({ preventScroll: true });
      }
    }
  }

  // ---- Pointer Events swipe-to-dismiss ----
  function onBodyTouchMove(ev) {
    if (!activeDrag || !activeDrag.fromBody) return;
    if (activeDrag.dragging && ev.cancelable) {
      ev.preventDefault();
    }
  }

  function cleanupDrag(resetStyles) {
    if (!activeDrag) return;
    if (activeDrag.captureTarget && typeof activeDrag.captureTarget.releasePointerCapture === 'function') {
      try {
        if (activeDrag.captureTarget.hasPointerCapture && activeDrag.captureTarget.hasPointerCapture(activeDrag.pointerId)) {
          activeDrag.captureTarget.releasePointerCapture(activeDrag.pointerId);
        }
      } catch (_) {}
    }
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
    bodyEl.removeEventListener('touchmove', onBodyTouchMove);
    activeDrag = null;
    if (resetStyles) {
      drawerEl.classList.remove('is-dragging');
      drawerEl.style.transform = '';
      backdropEl.style.opacity = '';
    }
  }

  function onDrawerPointerDown(ev) {
    if (!isOpenFlag || activeDrag !== null) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (ev.target && ev.target.closest('button, a, input, select, textarea')) return;

    var fromHeader = headerEl.contains(ev.target);
    var fromBody = !fromHeader && bodyEl.contains(ev.target);
    if (!fromHeader && !fromBody) return;

    if (fromBody) {
      // iOS-sheet rule: mouse drags inside body select text; touch/pen engages only at scrollTop === 0
      if (ev.pointerType === 'mouse' || bodyEl.scrollTop > 0) return;
    }

    var now = ev.timeStamp || performance.now();
    activeDrag = {
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      fromHeader: fromHeader,
      fromBody: fromBody,
      dragging: fromHeader,
      dy: 0,
      samples: [{ y: ev.clientY, t: now }],
      captureTarget: fromHeader ? headerEl : null
    };

    if (fromHeader) {
      drawerEl.classList.add('is-dragging');
      try { headerEl.setPointerCapture(ev.pointerId); } catch (_) {}
    } else {
      bodyEl.addEventListener('touchmove', onBodyTouchMove, { passive: false });
    }

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
  }

  function onPointerMove(ev) {
    if (!activeDrag || ev.pointerId !== activeDrag.pointerId) return;
    var dx = ev.clientX - activeDrag.startX;
    var dy = ev.clientY - activeDrag.startY;
    var now = ev.timeStamp || performance.now();

    if (!activeDrag.dragging) {
      if (bodyEl.scrollTop > 0 || dy < -4) {
        cleanupDrag(false);
        return;
      }
      if (dy > 6 && Math.abs(dy) >= Math.abs(dx)) {
        activeDrag.dragging = true;
        activeDrag.startY = ev.clientY;
        dy = 0;
        activeDrag.samples = [{ y: ev.clientY, t: now }];
        drawerEl.classList.add('is-dragging');
        activeDrag.captureTarget = bodyEl;
        try { bodyEl.setPointerCapture(ev.pointerId); } catch (_) {}
      } else {
        return;
      }
    }

    if (ev.cancelable) ev.preventDefault();
    activeDrag.dy = dy;
    activeDrag.samples.push({ y: ev.clientY, t: now });
    while (activeDrag.samples.length > 2 && now - activeDrag.samples[0].t > 120) {
      activeDrag.samples.shift();
    }

    var visualDy = dy >= 0 ? dy : Math.max(-36, dy * 0.25);
    drawerEl.style.transform = 'translateY(' + visualDy.toFixed(1) + 'px)';

    var h = drawerEl.getBoundingClientRect().height || 300;
    var ratio = Math.max(0, Math.min(1, visualDy / h));
    backdropEl.style.opacity = String(1 - ratio * 0.65);
  }

  function onPointerUp(ev) {
    if (!activeDrag || ev.pointerId !== activeDrag.pointerId) return;
    if (!activeDrag.dragging) {
      cleanupDrag(false);
      return;
    }

    var now = ev.timeStamp || performance.now();
    var dy = ev.clientY - activeDrag.startY;
    var h = drawerEl.getBoundingClientRect().height || 300;

    var samples = activeDrag.samples;
    var refSample = samples[0] || { y: activeDrag.startY, t: now };
    for (var i = samples.length - 1; i >= 0; i--) {
      refSample = samples[i];
      if (now - samples[i].t >= 80) break;
    }
    var dt = now - refSample.t;
    var vy = dt > 0 ? (ev.clientY - refSample.y) / dt : 0;

    var shouldDismiss = (dy >= h * 0.33) || (dy > 20 && vy > 0.5);
    cleanupDrag(true);

    if (shouldDismiss) {
      close();
    }
  }

  function onPointerCancel(ev) {
    if (!activeDrag || ev.pointerId !== activeDrag.pointerId) return;
    cleanupDrag(true);
  }

  // ---- Flagging hook ----
  function handleFlagClick() {
    if (!activeView || typeof cfg.onFlagNote !== 'function') return;
    var pd = activeView.pageData;
    var note = activeView.note;
    var firstPara = (Array.isArray(note.paragraphs) && note.paragraphs[0]) || null;
    var firstLine = (firstPara && Array.isArray(firstPara.lines) && firstPara.lines[0]) || null;
    var trigger = initialTriggerEl;

    var ctx = {
      pageId: pd.page,
      pageN: pd.n,
      paraPid: (firstPara && firstPara.pid) || (pd.page + ':n' + activeView.noteIdx + ':0'),
      paraIndex: 0,
      lineId: (firstLine && firstLine.id) || note.id || '',
      lineText: (firstLine && firstLine.t) || note.t || '',
      isFootnote: true,
      noteId: note.id || '',
      marker: note.marker || '',
      note: note,
      triggerEl: trigger
    };

    close();
    cfg.onFlagNote(ctx);
  }

  // ---- Public API ----
  function buildDom() {
    if (drawerEl && drawerEl.parentNode) drawerEl.parentNode.removeChild(drawerEl);
    if (backdropEl && backdropEl.parentNode) backdropEl.parentNode.removeChild(backdropEl);

    backdropEl = el('div', 'fn-drawer-backdrop');
    backdropEl.setAttribute('aria-hidden', 'true');
    backdropEl.addEventListener('click', function () { close(); });

    drawerEl = el('section', 'fn-drawer');
    drawerEl.id = 'footnote-drawer';
    drawerEl.setAttribute('role', 'dialog');
    drawerEl.setAttribute('aria-modal', 'true');
    drawerEl.setAttribute('aria-labelledby', 'fn-drawer-title');
    drawerEl.setAttribute('aria-hidden', 'true');
    drawerEl.setAttribute('dir', 'rtl');
    drawerEl.tabIndex = -1;
    drawerEl.inert = true;

    headerEl = el('div', 'fn-drawer-header');
    handleEl = el('div', 'fn-drawer-handle');
    handleEl.setAttribute('aria-hidden', 'true');
    handleEl.appendChild(el('span', 'fn-drag-pill'));
    headerEl.appendChild(handleEl);

    var headerRow = el('div', 'fn-header-row');
    var titleWrap = el('div', 'fn-title-wrap');
    titleEl = el('h2', 'fn-drawer-title', L('הערה', 'Note'));
    titleEl.id = 'fn-drawer-title';
    titleEl.tabIndex = -1;
    metaEl = el('span', 'fn-drawer-meta');
    metaEl.id = 'fn-drawer-meta';
    titleWrap.appendChild(titleEl);
    titleWrap.appendChild(metaEl);

    var actionsEl = el('div', 'fn-header-actions');
    backBtn = el('button', 'fn-btn fn-back-btn', L('חזרה', 'Back'));
    backBtn.id = 'fn-back-btn';
    backBtn.type = 'button';
    backBtn.hidden = true;
    backBtn.setAttribute('aria-label', L('חזרה להערה הקודמת', 'Back to previous note'));
    backBtn.addEventListener('click', function () {
      if (!historyStack.length) return;
      var prev = historyStack.pop();
      navigateToNote(prev.pageId, prev.noteIdx, false);
    });

    expandBtn = el('button', 'fn-btn fn-expand-btn', L('הרחב', 'Expand'));
    expandBtn.id = 'fn-expand-btn';
    expandBtn.type = 'button';
    expandBtn.hidden = true;
    expandBtn.setAttribute('aria-expanded', 'false');
    expandBtn.setAttribute('aria-label', L('הרחב חלונית הערה', 'Expand note panel'));
    expandBtn.addEventListener('click', function () {
      setExpanded(!isExpandedFlag);
    });

    flagBtn = el('button', 'fn-btn fn-flag-btn', (window.RYMH_LANG === 'en') ? 'Flag' : 'הצע תיקון');
    flagBtn.id = 'fn-flag-btn';
    flagBtn.type = 'button';
    flagBtn.hidden = true;
    flagBtn.setAttribute('aria-label', (window.RYMH_LANG === 'en') ? 'Flag note' : 'הצע תיקון להערה');
    flagBtn.addEventListener('click', handleFlagClick);

    closeBtn = el('button', 'fn-btn fn-close-btn', '✕');
    closeBtn.id = 'close-drawer-btn';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', L('סגור הערה', 'Close note'));
    closeBtn.addEventListener('click', function () { close(); });

    actionsEl.appendChild(backBtn);
    actionsEl.appendChild(expandBtn);
    actionsEl.appendChild(flagBtn);
    actionsEl.appendChild(closeBtn);

    headerRow.appendChild(titleWrap);
    headerRow.appendChild(actionsEl);
    headerEl.appendChild(headerRow);

    bodyEl = el('div', 'fn-drawer-body');
    bodyEl.id = 'fn-drawer-body';
    bodyEl.tabIndex = 0;
    bodyEl.setAttribute('role', 'region');
    bodyEl.setAttribute('aria-label', L('תוכן ההערה', 'Note text'));

    footerEl = el('div', 'fn-drawer-footer');
    footerEl.id = 'fn-drawer-footer';
    footerEl.hidden = true;

    drawerEl.appendChild(headerEl);
    drawerEl.appendChild(bodyEl);
    drawerEl.appendChild(footerEl);

    drawerEl.addEventListener('pointerdown', onDrawerPointerDown);

    var mount = cfg.mountEl || document.getElementById('footnoteDrawerRoot') || document.body;
    mount.appendChild(backdropEl);
    mount.appendChild(drawerEl);
  }

  function init(opts) {
    opts = opts || {};
    if (isOpenFlag) close();
    cfg.mountEl = opts.mountEl || document.getElementById('footnoteDrawerRoot') || document.body;
    cfg.inertEl = opts.inertEl || null;
    cfg.getPageData = opts.getPageData || null;
    cfg.onHighlightLine = opts.onHighlightLine || null;
    cfg.onFlagNote = opts.onFlagNote || null;

    buildDom();

    if (!docListenersBound) {
      document.addEventListener('keydown', onDocumentKeyDown, true);
      docListenersBound = true;
    }
  }

  function open(opts) {
    opts = opts || {};
    if (!drawerEl) init({});

    openSeq += 1;
    var wasOpen = isOpenFlag;

    if (!wasOpen) {
      historyStack = [];
      var candTrigger = null;
      if (opts.triggerEl && opts.triggerEl.nodeType === 1 && opts.triggerEl.isConnected && !drawerEl.contains(opts.triggerEl)) {
        candTrigger = opts.triggerEl;
      } else if (document.activeElement && document.activeElement !== document.body && !drawerEl.contains(document.activeElement)) {
        candTrigger = document.activeElement;
      }
      initialTriggerEl = candTrigger;
      if (initialTriggerEl) initialTriggerEl.classList.add('is-active');

      applyBackgroundInert();
      drawerEl.inert = false;
      drawerEl.removeAttribute('aria-hidden');
      backdropEl.removeAttribute('aria-hidden');
      drawerEl.classList.remove('is-dragging');
      drawerEl.style.transform = '';
      backdropEl.style.opacity = '';
      // Force layout before adding .open when reduced motion is off so transition starts cleanly
      if (!prefersReducedMotion()) {
        void drawerEl.offsetHeight;
      }
      backdropEl.classList.add('open');
      drawerEl.classList.add('open');
      isOpenFlag = true;
    }

    navigateToNote(opts.page, opts, wasOpen);

    if (!wasOpen) {
      if (closeBtn && typeof closeBtn.focus === 'function') {
        closeBtn.focus({ preventScroll: true });
      } else {
        drawerEl.focus({ preventScroll: true });
      }
    }
  }

  function close() {
    if (!isOpenFlag) return;
    isOpenFlag = false;
    openSeq += 1;
    cleanupDrag(true);
    clearActiveHighlight();

    drawerEl.classList.remove('open');
    drawerEl.classList.remove('is-expanded');
    backdropEl.classList.remove('open');
    drawerEl.setAttribute('aria-hidden', 'true');
    drawerEl.inert = true;
    backdropEl.setAttribute('aria-hidden', 'true');

    var restoreTarget = initialTriggerEl;
    initialTriggerEl = null;
    historyStack = [];
    activeView = null;
    isExpandedFlag = false;

    // IMPORTANT: restore background inert BEFORE returning focus to triggerEl
    restoreBackgroundInert();

    if (restoreTarget) {
      restoreTarget.classList.remove('is-active');
      if (restoreTarget.isConnected && typeof restoreTarget.focus === 'function') {
        restoreTarget.focus({ preventScroll: true });
      }
    }
  }

  function isOpen() {
    return isOpenFlag;
  }

  window.FootnoteDrawer = {
    init: init,
    open: open,
    close: close,
    isOpen: isOpen
  };
})();
