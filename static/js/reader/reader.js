// Public reader, milestone 2: virtualized continuous cross-page reading,
// dual-pane scan sync, mobile swipe pager, accessible footnote drawer & flagging mount hooks.
// Reads only static JSON (reader_data/). All text goes through textContent / text nodes.
(function () {
  'use strict';
  var T = window.RYMH_T || function (x) { return x; };

  var DATA = 'reader_data/';
  var THEMES = ['dark', 'sepia', 'light'];
  // Flow mode (reader-flow.html, <html class="flow">): every page stays mounted so a paragraph
  // that crosses a page break continues on the same line; the page number sits in the margin.
  var FLOW = document.documentElement.classList.contains('flow-mode');
  var WINDOW_RADIUS = FLOW ? 1000 : 1; // normal: ~3 pages virtualized in DOM: [center-1, center, center+1]

  // "PageNo (DafAmud)": page 1 = עה: (daf 75 amud bet), page 2 = עו, ...
  function toHebrewNumeral(n) {
    var hundreds = ['', 'ק', 'ר', 'ש', 'ת'];
    var tens = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
    var ones = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
    var h = Math.floor(n / 100), rem = n % 100;
    if (rem === 15) return hundreds[h] + 'טו';
    if (rem === 16) return hundreds[h] + 'טז';
    return hundreds[h] + tens[Math.floor(rem / 10)] + ones[rem % 10];
  }
  function dafAmud(pn) { return toHebrewNumeral(75 + Math.floor(pn / 2)) + (pn % 2 === 1 ? ':' : ''); }

  var readerShell = document.getElementById('readerShell');
  var barEl = document.getElementById('bar');
  var bookEl = document.getElementById('bookTitle');
  var hereEl = document.getElementById('here');
  var progressEl = document.getElementById('progressBar');
  var pageSelect = document.getElementById('pageSelect');
  var scanToggle = document.getElementById('scanToggle');
  var grid = document.getElementById('grid');

  var stageEl = document.getElementById('stage');
  var pagerTrackEl = document.getElementById('pagerTrack');
  var scanPaneEl = document.getElementById('scanPane');
  var scanTrackEl = document.getElementById('scanTrack');
  var textPaneEl = document.getElementById('textPane');
  var streamEl = document.getElementById('stream');
  var flowEl = null;

  var pages = [];         // index.json entries
  var indexByN = {};      // n -> index entry
  var pageCache = {};     // n -> page-NN.json data
  var inflight = {};      // n -> Promise
  var textSlotsByN = {};  // n -> .page-slot
  var mountedTextNs = {}; // n -> true
  var measuredH = {};     // n -> last measured height px
  var total = 0;
  var currentN = 1;
  var hashTimer = null;
  var activeTextHoverEl = null;

  var syncController = null;
  var scanPane = null;
  var mobilePager = null;

  function store(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function pageId(n) { return 'page-' + pad(n); }
  function parsePageN(pid) {
    if (typeof pid === 'number') return pid;
    var m = /(\d+)$/.exec(String(pid || ''));
    return m ? parseInt(m[1], 10) : 0;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function normMarker(m) {
    return String(m || '')
      .replace(/["״'׳\s()]/g, '')
      .replace(/ך/g, 'כ')
      .replace(/ם/g, 'מ')
      .replace(/ן/g, 'נ')
      .replace(/ף/g, 'פ')
      .replace(/ץ/g, 'צ');
  }

  // At most 6 requests in flight (flow mode asks for all 89 pages at once), one retry each.
  var fetchQueue = [];
  var fetchActive = 0;
  function pumpFetches() {
    while (fetchActive < 6 && fetchQueue.length) {
      var job = fetchQueue.shift();
      fetchActive++;
      job();
    }
  }
  function fetchOnce(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return r.json();
    });
  }
  function fetchJson(url) {
    return new Promise(function (resolve, reject) {
      fetchQueue.push(function () {
        fetchOnce(url).catch(function () { return fetchOnce(url); })
          .then(resolve, reject)
          .then(function () { fetchActive--; pumpFetches(); });
      });
      pumpFetches();
    });
  }

  function getPageData(pageIdOrN) {
    var n = parsePageN(pageIdOrN);
    if (!n || !indexByN[n]) return Promise.reject(new Error('Unknown page: ' + pageIdOrN));
    if (pageCache[n]) return Promise.resolve(pageCache[n]);
    if (inflight[n]) return inflight[n];
    var pMeta = indexByN[n];
    inflight[n] = fetchJson(DATA + pMeta.page + '.json').then(function (data) {
      pageCache[n] = data;
      delete inflight[n];
      return data;
    }, function (err) {
      delete inflight[n];
      throw err;
    });
    return inflight[n];
  }

  function getCachedPage(n) {
    return pageCache[n] || null;
  }

  // ---- text + inline marker rendering ----
  function makeNoteTrigger(page, note, noteIdx, labelText, isContChip) {
    var btn = el('button', isContChip ? 'fn-ref fn-ref-cont' : 'fn-ref', labelText);
    btn.type = 'button';
    btn.setAttribute('data-fn-trigger', 'true');
    btn.setAttribute('data-page', page.page);
    btn.setAttribute('data-n', String(page.n));
    btn.setAttribute('data-note-idx', String(noteIdx));
    btn.setAttribute('data-note-id', note.id || '');
    btn.setAttribute('data-marker', note.marker || '');
    var label = T('הערה') + ' ' + (note.marker || (noteIdx + 1)) + ' (' + T('עמוד') + ' ' + page.n + (note.continued ? ', ' + T('המשך') : '') + ')';
    btn.setAttribute('aria-label', label);
    return btn;
  }

  function appendSegmentWithMarkers(parent, text, page, matcher) {
    if (!text) return;
    if (!matcher || !matcher.remainingCount) {
      parent.appendChild(document.createTextNode(text));
      return;
    }
    var parts = text.split(/(\([^()\s]{1,8}\))/g);
    for (var i = 0; i < parts.length; i++) {
      var tok = parts[i];
      if (!tok) continue;
      if (tok.charAt(0) === '(' && tok.charAt(tok.length - 1) === ')') {
        var norm = normMarker(tok.slice(1, -1));
        var cand = norm && matcher.byNorm[norm];
        if (cand && !matcher.matched[cand.idx]) {
          matcher.matched[cand.idx] = true;
          matcher.remainingCount--;
          parent.appendChild(makeNoteTrigger(page, cand.note, cand.idx, tok, false));
          continue;
        }
      }
      parent.appendChild(document.createTextNode(tok));
    }
  }

  function appendRich(parent, text, page, matcher) {
    var parts = String(text || '').split(/\*\*(.+?)\*\*/g);
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (i % 2 === 1) {
        var b = document.createElement('b');
        appendSegmentWithMarkers(b, parts[i], page, matcher);
        parent.appendChild(b);
      } else {
        appendSegmentWithMarkers(parent, parts[i], page, matcher);
      }
    }
  }

  function makeDivider(page) {
    var div = el('div', 'divider');
    var label = el('span', null, T('עמוד') + ' ' + page.n);
    label.setAttribute('dir', 'rtl');
    var scan = el('a', 'scan-link', T('הדפוס'));
    scan.href = page.img || ('page_images/' + page.page + '.png');
    scan.target = '_blank';
    scan.rel = 'noopener';
    scan.setAttribute('aria-label', T('פתח את הדפוס של עמוד') + ' ' + page.n);
    div.appendChild(label);
    div.appendChild(scan);
    return div;
  }

  function buildMatcher(page) {
    var byNorm = {};
    var remainingCount = 0;
    var notes = page.notes || [];
    for (var i = 0; i < notes.length; i++) {
      var nt = notes[i];
      if (nt.continued || nt.within || !nt.marker) continue;
      var nm = normMarker(nt.marker);
      if (nm && !byNorm[nm]) {
        byNorm[nm] = { idx: i, note: nt };
        remainingCount++;
      }
    }
    return { byNorm: byNorm, matched: {}, remainingCount: remainingCount };
  }

  // Margin page number for flow mode: "עמ׳ 6" over "עז" (or "p. 6" in English).
  function makePgNum(page) {
    var m = el('span', 'pgnum');
    m.setAttribute('data-n', String(page.n));
    m.setAttribute('aria-label', T('עמוד') + ' ' + page.n + ' (' + dafAmud(page.n) + ')');
    m.setAttribute('role', 'note');
    m.appendChild(el('span', 'pgnum-n', (window.RYMH_LANG === 'en' ? 'p. ' : 'עמ׳ ') + page.n));
    m.appendChild(el('span', 'pgnum-d', dafAmud(page.n)));
    return m;
  }

  // Put each margin page number level with the first line of its page's text. Measured, because
  // an inline marker would stay on the previous line whenever the first word wraps.
  var pgNumTimer = 0;
  function placePgNums() {
    if (!FLOW) return;
    var marks = streamEl.querySelectorAll('.pgnum');
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      var target = m.nextElementSibling;
      var box = m.offsetParent;
      if (!target || !box) continue;
      var rects = target.getClientRects();
      if (!rects.length) continue;
      m.style.top = (rects[0].top - box.getBoundingClientRect().top) + 'px';
    }
  }
  function schedulePgNums() {
    if (!FLOW) return;
    cancelAnimationFrame(pgNumTimer);
    pgNumTimer = requestAnimationFrame(placePgNums);
  }
  if (FLOW && window.ResizeObserver) {
    // Any reflow of the text (window size, font size, scan pane shown/hidden) moves the lines.
    new ResizeObserver(schedulePgNums).observe(streamEl);
  }

  function appendLines(container, p, page, matcher) {
    var lines = p.lines || [];
    for (var li = 0; li < lines.length; li++) {
      if (li > 0) container.appendChild(document.createTextNode(' '));
      var line = lines[li];
      var span = el('span', 'rline');
      span.setAttribute('data-page', page.page);
      span.setAttribute('data-para', p.pid);
      span.setAttribute('data-line-id', line.id);
      span.setAttribute('data-line-idx', String(li));
      appendRich(span, line.t, page, matcher);
      container.appendChild(span);
    }
  }

  function lastParaOfSlot(n) {
    var prev = textSlotsByN[n];
    if (!prev || !mountedTextNs[n]) return null;
    var ps = prev.querySelectorAll('p.para');
    return ps.length ? ps[ps.length - 1] : null;
  }

  function mountTextSlot(n, page) {
    var slot = textSlotsByN[n];
    if (!slot || !page || mountedTextNs[n]) return;

    slot.style.blockSize = '';
    slot.textContent = '';

    var anchor = el('div', 'page-anchor');
    anchor.id = page.page;
    anchor.setAttribute('data-n', String(page.n));
    slot.appendChild(anchor);
    slot.appendChild(makeDivider(page));

    var matcher = buildMatcher(page);
    var paras = page.paragraphs || [];
    var pgNumPlaced = !FLOW;

    for (var i = 0; i < paras.length; i++) {
      var p = paras[i];

      // Flow mode: a paragraph continued from the previous page joins that page's last paragraph
      // on the same line, wrapped in an inline span that still carries this page's anchors.
      if (FLOW && i === 0 && p.cont) {
        var prevP = lastParaOfSlot(n - 1);
        if (prevP) {
          // Sync anchors must not nest: the first time a paragraph is joined, move its own lines
          // into an inline span carrying its anchor and drop the anchor from the outer block, so
          // each page's part of the joined paragraph is a separate, side-by-side anchor.
          var prevBlock = prevP.closest('.para-block');
          if (prevBlock && prevBlock.hasAttribute('data-para')) {
            var head = el('span', 'para-flow');
            head.setAttribute('data-page', prevBlock.getAttribute('data-page'));
            head.setAttribute('data-para', prevBlock.getAttribute('data-para'));
            while (prevP.firstChild) head.appendChild(prevP.firstChild);
            prevP.appendChild(head);
            prevBlock.setAttribute('data-flow-para', prevBlock.getAttribute('data-para'));
            prevBlock.removeAttribute('data-para');
          }
          var cont = el('span', 'para-flow');
          cont.setAttribute('data-page', page.page);
          cont.setAttribute('data-para', p.pid);
          prevP.appendChild(document.createTextNode(' '));
          prevP.appendChild(makePgNum(page));
          appendLines(cont, p, page, matcher);
          prevP.appendChild(cont);
          pgNumPlaced = true;
          continue;
        }
      }
      var heads = p.heads || [];
      for (var hi = 0; hi < heads.length; hi++) {
        var h = el('h2', 'chapter', heads[hi]);
        h.setAttribute('data-title', heads[hi]);
        slot.appendChild(h);
      }

      if (p.h1) {
        var h1t = (p.lines || []).map(function (l) { return l.t; }).join(' ');
        var h1 = el('h1', 'chapter h1');
        h1.setAttribute('data-title', h1t);
        h1.setAttribute('data-page', page.page);
        h1.setAttribute('data-para', p.pid);
        if (p.lines && p.lines[0]) {
          var h1Span = el('span', 'rline');
          h1Span.setAttribute('data-page', page.page);
          h1Span.setAttribute('data-para', p.pid);
          h1Span.setAttribute('data-line-id', p.lines[0].id);
          h1Span.setAttribute('data-line-idx', '0');
          appendRich(h1Span, h1t, page, matcher);
          h1.appendChild(h1Span);
        } else {
          h1.textContent = h1t;
        }
        if (!pgNumPlaced) { h1.insertBefore(makePgNum(page), h1.firstChild); pgNumPlaced = true; }
        slot.appendChild(h1);
        continue;
      }

      var block = el('div', 'para-block');
      block.setAttribute('data-page', page.page);
      block.setAttribute('data-para', p.pid);

      var pEl = el('p', p.cont ? 'para cont' : 'para');
      pEl.setAttribute('dir', 'rtl');
      if (i === 0 && p.cont) {
        var mark = el('span', 'pgmark', '[' + T('עמוד') + ' ' + page.n + ']');
        mark.setAttribute('dir', window.RYMH_LANG === 'en' ? 'ltr' : 'rtl');
        pEl.appendChild(mark);
        pEl.appendChild(document.createTextNode(' '));
      }

      if (!pgNumPlaced) { pEl.appendChild(makePgNum(page)); pgNumPlaced = true; }
      appendLines(pEl, p, page, matcher);
      block.appendChild(pEl);

      slot.appendChild(block);
    }

    // Page-level fallback triggers only for non-continued notes whose marker was not matched inline.
    // Continued notes are stitched directly into the starting page's footnote drawer.
    var notes = page.notes || [];
    var stripBtns = [];
    for (var ni = 0; ni < notes.length; ni++) {
      var nt = notes[ni];
      if (!nt.continued && !nt.within && !matcher.matched[ni]) {
        var btnText = T('הערה') + ' (' + (nt.marker || (ni + 1)) + ')';
        stripBtns.push(makeNoteTrigger(page, nt, ni, btnText, true));
      }
    }
    if (stripBtns.length) {
      var strip = el('div', 'page-fn-strip');
      strip.setAttribute('aria-label', T('הערות עמוד') + ' ' + page.n);
      for (var si = 0; si < stripBtns.length; si++) {
        strip.appendChild(stripBtns[si]);
      }
      slot.appendChild(strip);
    }

    mountedTextNs[n] = true;
    measuredH[n] = slot.offsetHeight;
  }

  function unmountTextSlot(n) {
    var slot = textSlotsByN[n];
    if (!slot || !mountedTextNs[n]) return;
    var h = slot.offsetHeight || measuredH[n] || 400;
    measuredH[n] = h;
    slot.textContent = '';
    slot.style.blockSize = h + 'px';
    delete mountedTextNs[n];
  }

  function initTextSlots() {
    flowEl = el('div', 'flow');
    var frag = document.createDocumentFragment();
    for (var i = 0; i < pages.length; i++) {
      var p = pages[i];
      var slot = el('section', 'page-slot');
      slot.setAttribute('data-page', p.page);
      slot.setAttribute('data-n', String(p.n));
      var est = Math.max(180, (p.paragraphs || 1) * 145 + (p.notes ? 56 : 0) + 48);
      measuredH[p.n] = est;
      slot.style.blockSize = est + 'px';
      textSlotsByN[p.n] = slot;
      frag.appendChild(slot);
    }
    flowEl.appendChild(frag);
    streamEl.textContent = '';
    streamEl.appendChild(flowEl);
  }

  function windowRange(centerN) {
    var out = [];
    var lo = Math.max(1, centerN - WINDOW_RADIUS);
    var hi = Math.min(total, centerN + WINDOW_RADIUS);
    for (var n = lo; n <= hi; n++) out.push(n);
    return out;
  }

  function applyWindowSync(centerN) {
    var wanted = windowRange(centerN);
    var wantedSet = {};
    for (var i = 0; i < wanted.length; i++) wantedSet[wanted[i]] = true;

    if (syncController) syncController.setResizeSuppressed(true);
    try {
      var mountedKeys = Object.keys(mountedTextNs);
      for (var j = 0; j < mountedKeys.length; j++) {
        var oldN = Number(mountedKeys[j]);
        if (!wantedSet[oldN]) {
          if (oldN < centerN && textSlotsByN[oldN]) {
            unmountTextSlot(oldN);
          } else {
            unmountTextSlot(oldN);
          }
        }
      }

      for (var k = 0; k < wanted.length; k++) {
        var n = wanted[k];
        if (!mountedTextNs[n] && pageCache[n] && textSlotsByN[n]) {
          var slot = textSlotsByN[n];
          var beforeH = slot.offsetHeight;
          var aboveAnchor = n < currentN;
          mountTextSlot(n, pageCache[n]);
          var afterH = slot.offsetHeight;
          if (aboveAnchor && Math.abs(afterH - beforeH) >= 0.5 && textPaneEl) {
            textPaneEl.scrollTop += (afterH - beforeH);
          }
        }
      }

      if (scanPane) {
        scanPane.setWindow(wanted, getCachedPage);
        scanPane.preloadAround(centerN);
      }
      schedulePgNums();
    } finally {
      if (syncController) syncController.setResizeSuppressed(false);
    }
  }

  function ensureWindow(centerN) {
    var wanted = windowRange(centerN);
    applyWindowSync(centerN);

    var missing = wanted.filter(function (n) { return !pageCache[n]; });
    if (!missing.length) return Promise.resolve();

    return Promise.all(missing.map(function (n) { return getPageData(n); })).then(function () {
      // Only mount if still near current window
      var latestWanted = windowRange(currentN);
      var anyNeeded = latestWanted.some(function (n) { return !mountedTextNs[n] && pageCache[n]; });
      if (anyNeeded) {
        applyWindowSync(currentN);
        if (syncController) syncController.resync();
      }
    });
  }

  // ---- status, progress & mobile bar ----
  var lastTextScrollY = 0;
  var holdBar = 0;
  function updateBar() {
    if (!textPaneEl || !barEl) return;
    var y = textPaneEl.scrollTop;
    var narrow = window.matchMedia('(max-width: 560px)').matches;
    var dy = y - lastTextScrollY;
    lastTextScrollY = y;
    if (!narrow || y < 120 || Date.now() < holdBar) {
      barEl.classList.remove('hide');
      return;
    }
    if (dy > 6) {
      barEl.style.setProperty('--bar-live-h', barEl.offsetHeight + 'px');
      barEl.classList.add('hide');
    }
    else if (dy < -6) barEl.classList.remove('hide');
  }

  function setBarHeight() {
    if (barEl) {
      document.documentElement.style.setProperty('--bar-h', barEl.offsetHeight + 'px');
    }
  }

  function updateStatus(n) {
    if (n && n !== currentN) {
      currentN = n;
      clearTimeout(hashTimer);
      hashTimer = setTimeout(function () {
        try { history.replaceState(null, '', '#' + pageId(currentN)); } catch (e) {}
      }, 250);
    }
    if (FLOW && scanPane && scanPane.ensureLoaded) scanPane.ensureLoaded(currentN);
    if (pageSelect && pageSelect.value !== String(currentN) && document.activeElement !== pageSelect) {
      pageSelect.value = String(currentN);
    }
    var text = T('עמוד') + ' ' + currentN + ' ' + T('מתוך') + ' ' + total;
    if (hereEl && hereEl.textContent !== text) hereEl.textContent = text;
    if (progressEl && textPaneEl) {
      var span = Math.max(1, textPaneEl.scrollHeight - textPaneEl.clientHeight);
      var pct = Math.min(100, Math.max(0, (textPaneEl.scrollTop / span) * 100));
      progressEl.style.width = pct.toFixed(2) + '%';
    }
  }

  // ---- hover & inspect highlighting ----
  function highlightLineSafe(pageIdStr, lineId, active, className) {
    if (!lineId) return;
    var cls = className || 'is-hover';
    var lines = streamEl.querySelectorAll('.rline[data-line-id]');
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].getAttribute('data-line-id') === lineId &&
          (!pageIdStr || lines[i].getAttribute('data-page') === pageIdStr)) {
        lines[i].classList.toggle(cls, !!active);
      }
    }
    if (scanPane) scanPane.highlight(pageIdStr, lineId, null, !!active, cls);
  }

  function setInspectHighlight(pageIdStr, lineId) {
    var prevText = streamEl.querySelectorAll('.rline.is-inspecting');
    for (var i = 0; i < prevText.length; i++) prevText[i].classList.remove('is-inspecting');
    if (scanTrackEl) {
      var prevScan = scanTrackEl.querySelectorAll('.scan-line-box.is-inspecting');
      for (var j = 0; j < prevScan.length; j++) prevScan[j].classList.remove('is-inspecting');
    }
    if (lineId) {
      highlightLineSafe(pageIdStr, lineId, true, 'is-inspecting');
    }
  }

  function scrollLineForInspect(pageIdStr, lineId, drawerHeightPx) {
    if (!textPaneEl || !streamEl || !lineId) return;
    var lines = streamEl.querySelectorAll('.rline[data-line-id]');
    var target = null;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].getAttribute('data-line-id') === lineId &&
          (!pageIdStr || lines[i].getAttribute('data-page') === pageIdStr)) {
        target = lines[i];
        break;
      }
    }
    if (!target) return;
    var paneRect = textPaneEl.getBoundingClientRect();
    var lineRect = target.getBoundingClientRect();
    var drawerH = (typeof drawerHeightPx === 'number' && drawerHeightPx > 0)
      ? drawerHeightPx
      : (function () {
          var d = document.getElementById('microDrawer');
          return d && d.classList.contains('open') ? (d.getBoundingClientRect().height || 0) : 0;
        })();
    var visibleH = Math.max(80, paneRect.height - drawerH);
    var relTop = lineRect.top - paneRect.top;
    var desiredTop = Math.max(24, (visibleH - lineRect.height) * 0.45);
    if (relTop < 20 || relTop + lineRect.height > visibleH - 16) {
      textPaneEl.scrollTop += (relTop - desiredTop);
    }
  }

  function handleHoverPair(pageIdStr, lineId, paraPid, active) {
    if (active && document.documentElement.classList.contains('no-line-hl')) return;
    highlightLineSafe(pageIdStr, lineId, active);
    if (scanPane && paraPid) scanPane.highlight(pageIdStr, null, paraPid, !!active);
  }

  function attachStreamEvents() {
    streamEl.addEventListener('pointerover', function (e) {
      var rline = e.target && e.target.closest ? e.target.closest('.rline[data-line-id]') : null;
      if (rline === activeTextHoverEl) return;
      if (activeTextHoverEl) {
        handleHoverPair(
          activeTextHoverEl.getAttribute('data-page'),
          activeTextHoverEl.getAttribute('data-line-id'),
          activeTextHoverEl.getAttribute('data-para'),
          false
        );
        activeTextHoverEl = null;
      }
      if (rline) {
        activeTextHoverEl = rline;
        handleHoverPair(
          rline.getAttribute('data-page'),
          rline.getAttribute('data-line-id'),
          rline.getAttribute('data-para'),
          true
        );
      }
    });

    streamEl.addEventListener('pointerleave', function () {
      if (activeTextHoverEl) {
        handleHoverPair(
          activeTextHoverEl.getAttribute('data-page'),
          activeTextHoverEl.getAttribute('data-line-id'),
          activeTextHoverEl.getAttribute('data-para'),
          false
        );
        activeTextHoverEl = null;
      }
    });

    streamEl.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-fn-trigger], .fn-ref') : null;
      if (!btn) return;
      var n = parseInt(btn.getAttribute('data-n'), 10);
      var noteIdx = parseInt(btn.getAttribute('data-note-idx'), 10);
      var noteId = btn.getAttribute('data-note-id') || '';
      if (!n) return;
      getPageData(n).then(function (pageData) {
        if (window.FootnoteDrawer && typeof window.FootnoteDrawer.open === 'function') {
          window.FootnoteDrawer.open({
            page: pageData,
            noteIndex: isNaN(noteIdx) ? 0 : noteIdx,
            noteId: noteId,
            triggerEl: btn
          });
        }
      });
    });

    textPaneEl.addEventListener('scroll', function () {
      updateBar();
      updateStatus(currentN);
    }, { passive: true });
  }

  // ---- navigation ----
  function go(n) {
    n = Math.round(Number(n));
    if (!n || n < 1 || n > total) return Promise.resolve(false);
    currentN = n;
    holdBar = Date.now() + 700;
    barEl.classList.remove('hide');

    var wanted = windowRange(n);
    return Promise.all(wanted.map(function (k) { return getPageData(k); })).then(function () {
      applyWindowSync(n);
      if (syncController) {
        var activePane = (mobilePager && mobilePager.isNarrow() && mobilePager.getScreen() === 'scan')
          ? 'scan'
          : 'text';
        syncController.scrollToPage(activePane, n);
      }
      updateStatus(n);
      try { history.replaceState(null, '', '#' + pageId(n)); } catch (e) {}
      return true;
    });
  }

  function hashPage() {
    var m = /^#page-(\d+)/.exec(location.hash);
    return m ? parseInt(m[1], 10) : 0;
  }

  // ---- line context for ReaderFlag ----
  function getLineContext(targetEl) {
    if (!targetEl || !targetEl.closest) return null;

    var fnBtn = targetEl.closest('[data-fn-trigger], .fn-ref');
    if (fnBtn) {
      var bn = parseInt(fnBtn.getAttribute('data-n'), 10);
      var bIdx = parseInt(fnBtn.getAttribute('data-note-idx'), 10);
      var bPage = pageCache[bn];
      if (bPage && bPage.notes && bPage.notes[bIdx]) {
        var bNote = bPage.notes[bIdx];
        return {
          pageId: bPage.page,
          pageN: bPage.n,
          paraPid: null,
          paraIndex: 0,
          lineId: bNote.id,
          lineText: bNote.t || '',
          isFootnote: true,
          noteId: bNote.id,
          marker: bNote.marker || ''
        };
      }
    }

    var lineEl = targetEl.closest('.rline[data-line-id]');
    if (!lineEl) {
      var block = targetEl.closest('.para-block[data-para], .para-block[data-flow-para]');
      if (block) lineEl = block.querySelector('.rline[data-line-id]');
    }
    if (!lineEl) return null;

    var pidStr = lineEl.getAttribute('data-page');
    var n = parsePageN(pidStr);
    var paraPid = lineEl.getAttribute('data-para') || '';
    var lineId = lineEl.getAttribute('data-line-id') || '';
    var isFn = lineEl.classList.contains('fn-line') || !!lineEl.closest('#footnote-drawer');
    var pageData = pageCache[n];

    var rawText = lineEl.textContent || '';
    var paraIndex = 0;
    var noteId = null;
    var marker = null;

    if (paraPid) {
      var pidMatch = /:(\d+)$/.exec(paraPid);
      if (pidMatch) paraIndex = parseInt(pidMatch[1], 10);
    }

    if (pageData) {
      if (isFn) {
        var notes = pageData.notes || [];
        for (var ni = 0; ni < notes.length && !noteId; ni++) {
          var nt = notes[ni];
          var nParas = nt.paragraphs || [];
          for (var npi = 0; npi < nParas.length; npi++) {
            var nLines = nParas[npi].lines || [];
            for (var nli = 0; nli < nLines.length; nli++) {
              if (nLines[nli].id === lineId) {
                noteId = nt.id;
                marker = nt.marker || '';
                rawText = nLines[nli].t || rawText;
                paraIndex = npi;
                break;
              }
            }
          }
        }
      } else {
        var paras = pageData.paragraphs || [];
        for (var pi = 0; pi < paras.length; pi++) {
          var pLines = paras[pi].lines || [];
          for (var li = 0; li < pLines.length; li++) {
            if (pLines[li].id === lineId && (!paraPid || paras[pi].pid === paraPid)) {
              rawText = pLines[li].t || rawText;
              paraIndex = pi;
              paraPid = paras[pi].pid;
              break;
            }
          }
        }
      }
    }

    return {
      pageId: pidStr || pageId(n),
      pageN: n,
      paraPid: paraPid || null,
      paraIndex: paraIndex,
      lineId: lineId,
      lineText: rawText,
      isFootnote: isFn,
      noteId: noteId,
      marker: marker
    };
  }

  // ---- controls ----
  function setupControls() {
    // Page dropdown: "PageNo (DafAmud)", as on the landing page (page 1 = עה:).
    if (pageSelect) {
      for (var pn = 1; pn <= total; pn++) {
        var opt = document.createElement('option');
        opt.value = String(pn);
        opt.textContent = pn + ' (' + dafAmud(pn) + ')';
        pageSelect.appendChild(opt);
      }
      pageSelect.value = String(currentN);
      pageSelect.addEventListener('change', function () {
        go(pageSelect.value).then(function (ok) { if (ok) pageSelect.blur(); });
      });
    }

    // Show / hide the printed scan beside the text (desktop; phones use the Text / Printed tabs).
    var LS_SCAN = 'rymh.scanHidden';
    function setScanHidden(hidden, keep) {
      readerShell.classList.toggle('scan-hidden', hidden);
      if (scanToggle) {
        scanToggle.setAttribute('aria-pressed', hidden ? 'false' : 'true');
        scanToggle.setAttribute('aria-label', hidden ? T('הצג את צילום הדפוס') : T('הסתר את צילום הדפוס'));
      }
      if (keep) { try { localStorage.setItem(LS_SCAN, hidden ? '1' : '0'); } catch (e) {} }
      if (!hidden && syncController) {
        requestAnimationFrame(function () { syncController.resync(); });
      }
    }
    var scanHiddenSaved = false;
    try { scanHiddenSaved = localStorage.getItem(LS_SCAN) === '1'; } catch (e) {}
    setScanHidden(scanHiddenSaved, false);
    if (scanToggle) {
      scanToggle.addEventListener('click', function () {
        setScanHidden(!readerShell.classList.contains('scan-hidden'), true);
      });
    }

    function bumpFont(d) {
      var cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-scale')) || 1;
      var next = Math.min(1.8, Math.max(0.8, Math.round((cur + d) * 10) / 10));
      var ratio = next / cur;
      var apply = function () {
        document.documentElement.style.setProperty('--font-scale', String(next));
        store('ih_reader_font', String(next));
        for (var k in measuredH) {
          if (!mountedTextNs[k]) measuredH[k] = Math.round(measuredH[k] * ratio);
          else if (textSlotsByN[k]) measuredH[k] = textSlotsByN[k].offsetHeight;
          if (!mountedTextNs[k] && textSlotsByN[k]) {
            textSlotsByN[k].style.blockSize = measuredH[k] + 'px';
          }
        }
      };
      if (syncController) syncController.preserveAnchorAndRun(apply);
      else apply();
    }

    document.getElementById('fontUp').addEventListener('click', function () { bumpFont(0.1); });
    document.getElementById('fontDown').addEventListener('click', function () { bumpFont(-0.1); });

    var markBtn = document.getElementById('markBtn');
    var markersOn = false;
    try { markersOn = localStorage.getItem('ih_reader_markers') !== '0'; } catch (e) {}
    function applyMarkers() {
      document.documentElement.setAttribute('data-markers', markersOn ? 'on' : 'off');
      markBtn.setAttribute('aria-pressed', markersOn ? 'true' : 'false');
    }
    applyMarkers();
    markBtn.addEventListener('click', function () {
      var apply = function () {
        markersOn = !markersOn;
        store('ih_reader_markers', markersOn ? '1' : '0');
        applyMarkers();
      };
      if (syncController) syncController.preserveAnchorAndRun(apply);
      else apply();
    });

    document.getElementById('themeBtn').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme') || 'dark';
      var next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
      document.documentElement.setAttribute('data-theme', next);
      store('ih_theme', next);
    });

    var gridBuilt = false;
    document.getElementById('gridBtn').addEventListener('click', function () {
      if (!gridBuilt) { buildGrid(); gridBuilt = true; }
      Array.prototype.forEach.call(grid.querySelectorAll('.tile'), function (t) {
        t.classList.toggle('current', Number(t.getAttribute('data-n')) === currentN);
      });
      if (typeof grid.showModal === 'function') grid.showModal();
    });
    document.getElementById('gridClose').addEventListener('click', function () { grid.close(); });
    grid.addEventListener('click', function (ev) { if (ev.target === grid) grid.close(); });

    var zoomInBtn = document.getElementById('scanZoomIn');
    var zoomOutBtn = document.getElementById('scanZoomOut');
    var zoomResetBtn = document.getElementById('scanZoomReset');
    function updateZoomLabel(z) {
      if (zoomResetBtn) zoomResetBtn.textContent = Math.round(z * 100) + '%';
    }
    if (zoomInBtn) {
      zoomInBtn.addEventListener('click', function () {
        if (!scanPane) return;
        var z = scanPane.setZoom(scanPane.getZoom() + 0.25);
        updateZoomLabel(z);
        if (syncController) syncController.resync();
      });
    }
    if (zoomOutBtn) {
      zoomOutBtn.addEventListener('click', function () {
        if (!scanPane) return;
        var z = scanPane.setZoom(scanPane.getZoom() - 0.25);
        updateZoomLabel(z);
        if (syncController) syncController.resync();
      });
    }
    if (zoomResetBtn) {
      zoomResetBtn.addEventListener('click', function () {
        if (!scanPane) return;
        var z = scanPane.setZoom(1);
        updateZoomLabel(z);
        if (syncController) syncController.resync();
      });
    }

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        setBarHeight();
        if (mobilePager) mobilePager.refresh();
      }, 120);
    });

    window.addEventListener('hashchange', function () {
      var n = hashPage();
      if (n && n !== currentN) go(n);
    });
  }

  function buildGrid() {
    var body = document.getElementById('gridBody');
    pages.forEach(function (p) {
      var a = el('a', 'tile');
      a.href = '#' + pageId(p.n);
      a.setAttribute('data-n', String(p.n));
      a.setAttribute('aria-label', T('עבור לעמוד') + ' ' + p.n);
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.width = 96; img.height = 124;
      img.src = 'thumbs/' + pageId(p.n) + '.webp';
      a.appendChild(img);
      a.appendChild(el('span', null, String(p.n)));
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        grid.close();
        go(p.n);
      });
      body.appendChild(a);
    });
  }

  function fail(msg) {
    streamEl.textContent = '';
    streamEl.appendChild(el('p', 'loading', msg));
  }

  function mountIntegrations() {
    if (window.FootnoteDrawer && typeof window.FootnoteDrawer.init === 'function') {
      window.FootnoteDrawer.init({
        mountEl: document.getElementById('footnoteDrawerRoot'),
        inertEl: readerShell,
        getPageData: getPageData,
        onHighlightLine: highlightLineSafe,
        onFlagNote: function (ctx) {
          if (window.ReaderFlag && typeof window.ReaderFlag.openForTarget === 'function') {
            window.ReaderFlag.openForTarget(ctx);
          }
        }
      });
    }

    if (window.ReaderFlag && typeof window.ReaderFlag.init === 'function') {
      window.ReaderFlag.init({
        mountEl: document.getElementById('readerFlagRoot'),
        barSlotEl: document.getElementById('readerFlagBarSlot'),
        streamEl: streamEl,
        inertEl: readerShell,
        getPageData: getPageData,
        getCachedPage: getCachedPage,
        getCurrentPage: function () { return currentN; },
        getTotalPages: function () { return total; },
        getLineContext: getLineContext,
        getScanImage: function (n) { return scanPane && scanPane.getImageEl ? scanPane.getImageEl(n) : null; },
        onInspectHighlight: setInspectHighlight,
        scrollLineForInspect: scrollLineForInspect,
        onInspectOpenChange: function (open) {
          if (readerShell) readerShell.classList.toggle('micro-open', !!open);
        },
        goToPage: go,
        config: window.READER_FLAG_CONFIG || null
      });
    }
  }

  function boot() {
    fetchJson(DATA + 'index.json').then(function (idx) {
      pages = idx.pages || [];
      total = pages.length;
      for (var i = 0; i < pages.length; i++) indexByN[pages[i].n] = pages[i];
      if (window.RYMH_LANG === 'en') {
        bookEl.textContent = 'Siman 187';
        document.title = 'Siman 187 — Reader';
      } else if (idx.title) {
        bookEl.textContent = idx.title;
      }

      var startN = hashPage();
      if (!startN || startN < 1 || startN > total) startN = 1;
      currentN = startN;

      initTextSlots();

      scanPane = window.ReaderScanPane.create({
        paneEl: scanPaneEl,
        trackEl: scanTrackEl,
        pagesIndex: pages,
        onHoverLine: handleHoverPair,
        onZoomPanStateChange: function (isPanning) {
          if (syncController) syncController.setPaused(isPanning);
        }
      });

      syncController = window.ReaderSyncController.create({
        readingRatio: 0.30,
        lockMs: 150,
        hysteresisPx: 48,
        onPageChange: function (newN) {
          updateStatus(newN);
          ensureWindow(newN);
        },
        onAnchorChange: function () {
          updateStatus(currentN);
        }
      });
      syncController.setCurrentPage(startN);
      syncController.registerPane('text', textPaneEl, flowEl);
      syncController.registerPane('scan', scanPaneEl, scanTrackEl);

      mobilePager = window.ReaderMobilePager.create({
        stageEl: stageEl,
        trackEl: pagerTrackEl,
        textPaneEl: textPaneEl,
        scanPaneEl: scanPaneEl,
        textTabBtn: document.getElementById('mobileTabText'),
        scanTabBtn: document.getElementById('mobileTabScan'),
        isBlocked: function () {
          return (window.FootnoteDrawer && window.FootnoteDrawer.isOpen && window.FootnoteDrawer.isOpen()) ||
                 (window.MicroView && window.MicroView.isOpen && window.MicroView.isOpen()) ||
                 !!(grid && grid.open);
        },
        onSwipeStateChange: function (swiping) {
          if (syncController) syncController.setPaused(swiping);
        },
        onScreenChange: function (nextScreen, prevScreen) {
          if (syncController) {
            syncController.syncFromPane(prevScreen === 'scan' ? 'scan' : 'text');
          }
          if (nextScreen === 'scan' && scanPane) {
            scanPane.preloadAround(currentN);
          }
        }
      });

      attachStreamEvents();
      setupControls();
      setBarHeight();
      mountIntegrations();

      var initialWanted = windowRange(startN);
      return Promise.all(initialWanted.map(function (n) { return getPageData(n); })).then(function () {
        applyWindowSync(startN);
        if (startN > 1) {
          holdBar = Date.now() + 700;
          syncController.scrollToPage('text', startN);
        } else {
          syncController.syncFromPane('text');
        }
        updateStatus(startN);
      });
    }).catch(function () {
      fail(T('הטקסט לא נטען. נסו לרענן את הדף.'));
    });
  }

  window.ReaderApp = {
    getCurrentPage: function () { return currentN; },
    goToPage: go,
    getMountedPages: function () {
      return Object.keys(mountedTextNs).map(Number).sort(function (a, b) { return a - b; });
    },
    getSyncController: function () { return syncController; },
    getScanPane: function () { return scanPane; },
    getMobilePager: function () { return mobilePager; },
    getPageData: getPageData,
    getCachedPage: getCachedPage,
    getTotalPages: function () { return total; },
    highlightLine: highlightLineSafe
  };

  boot();
})();
