/**
 * micro_view.js
 * 
 * Manages the Focused 3-Line Inspection Drawer:
 * - High-magnification dynamic canvas slice (Line N-1, N, N+1)
 * - Focused target line editor with Ashurit bolding (Cmd+B / Ctrl+B)
 * - Pre-filled AI redline suggestions with Accept/Reject
 * - Leaving a line by any route (↑ / ↓ / Prev / Next / Enter / Esc / Close)
 *   saves it if, and only if, its text changed. Unchanged lines are never written.
 * - Changing a line's text clears its verified mark.
 * - Enter = Verify & next; ↓ / Next = save (if changed) and move on without verifying.
 */

window.MicroView = (function() {
  let activeLineIdx = 0;
  let isOpen = false;
  let currentProposal = null;
  let microFontSize = 22;
  let customAdapter = null;
  let pendingDraftText = null;
  let windowEventsBound = false;
  let crossPageBusy = false;

  function isSuggestMode() {
    return !!(customAdapter && customAdapter.mode === 'suggest');
  }

  function getPageContextData() {
    if (customAdapter && typeof customAdapter.getPageData === 'function') {
      return customAdapter.getPageData();
    }
    return window.MacroView ? window.MacroView.getCurrentPageData() : null;
  }

  function getCurrentPageIdSafe(pageData) {
    if (pageData && pageData.pageId) return pageData.pageId;
    if (customAdapter && typeof customAdapter.getCurrentPageId === 'function') {
      return customAdapter.getCurrentPageId();
    }
    return window.MacroView ? window.MacroView.getCurrentPageId() : 'page-05';
  }

  function isSameSection(a, b) {
    if (!a || !b) return false;
    if (customAdapter && typeof customAdapter.isSameSection === 'function') {
      return customAdapter.isSameSection(a, b);
    }
    return true;
  }

  function initMicroFontSize() {
    const saved = localStorage.getItem('ih_micro_font_size');
    if (saved) {
      const n = parseInt(saved, 10);
      if (!isNaN(n) && n >= 16 && n <= 32) {
        microFontSize = n;
      }
    }
    applyMicroFontSize();
  }

  function applyMicroFontSize() {
    const drawer = document.getElementById('microDrawer');
    if (drawer) {
      drawer.style.setProperty('--font-size-micro-input', `${microFontSize}px`);
    } else {
      document.documentElement.style.setProperty('--font-size-micro-input', `${microFontSize}px`);
    }
    const disp = document.getElementById('microFontSizeDisplay');
    if (disp) {
      disp.textContent = `${microFontSize}px`;
    }
    localStorage.setItem('ih_micro_font_size', String(microFontSize));
  }

  function incMicroFontSize() {
    if (microFontSize < 32) {
      microFontSize += 1;
      applyMicroFontSize();
    }
  }

  function decMicroFontSize() {
    if (microFontSize > 16) {
      microFontSize -= 1;
      applyMicroFontSize();
    }
  }

  let drawerTriggerEl = null;

  function open(lineIdxOrId, opts) {
    setupEvents();
    if (isOpen && !(opts && opts.skipSave)) {
      const prevSave = saveCurrentLineInternal();
      if (prevSave.blocked) return;
    }
    const pageData = getPageContextData();
    if (!pageData || !pageData.lines || !pageData.lines.length) return;

    let lineIdx = 0;
    if (typeof lineIdxOrId === 'string') {
      const foundIdx = pageData.lines.findIndex(l => l && l.line_id === lineIdxOrId);
      lineIdx = foundIdx >= 0 ? foundIdx : 0;
    } else if (typeof lineIdxOrId === 'number' && isFinite(lineIdxOrId)) {
      lineIdx = Math.floor(lineIdxOrId);
    }
    if (!pageData.lines[lineIdx]) return;

    // Check passcode gate before entering micro edit mode (review.html only)
    if (!isSuggestMode() && !(customAdapter && customAdapter.skipPasscode)) {
      if (window.AuthGate && typeof window.AuthGate.checkPasscodeOrPrompt === 'function') {
        if (!window.AuthGate.checkPasscodeOrPrompt('🔒 Enter Reviewer Passcode to open line editor:')) {
          return;
        }
      }
    }

    activeLineIdx = lineIdx;
    isOpen = true;
    pendingDraftText = (opts && typeof opts.draftText === 'string') ? opts.draftText : null;
    drawerTriggerEl = (opts && opts.triggerEl) || null;

    const drawer = document.getElementById('microDrawer');
    if (drawer) drawer.classList.add('open');

    if (customAdapter && typeof customAdapter.onOpenChange === 'function') {
      customAdapter.onOpenChange(true);
    }

    renderLine();
  }

  function openForLineId(lineId, initialDraftText, opts) {
    const o = Object.assign({}, opts || {});
    if (typeof initialDraftText === 'string') o.draftText = initialDraftText;
    open(lineId, o);
  }

  function close(saveIfDirty = true) {
    if (saveIfDirty !== false) saveCurrentLineInternal({ allowCloseOnBlock: true });

    isOpen = false;
    pendingDraftText = null;
    const drawer = document.getElementById('microDrawer');
    if (drawer) drawer.classList.remove('open');

    if (customAdapter && typeof customAdapter.onActiveLineChange === 'function') {
      customAdapter.onActiveLineChange(null, -1, null);
    }
    if (customAdapter && typeof customAdapter.onOpenChange === 'function') {
      customAdapter.onOpenChange(false);
    }

    if (!customAdapter || customAdapter.scrollRowOnClose !== false) {
      const row = document.getElementById(`line-row-${activeLineIdx}`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
    if (drawerTriggerEl && drawerTriggerEl.isConnected !== false && typeof drawerTriggerEl.focus === 'function') {
      try { drawerTriggerEl.focus({ preventScroll: true }); } catch (e) {}
    }
    drawerTriggerEl = null;
  }

  function applyLockState(isLocked) {
    const input = document.getElementById('microTargetInput');
    const lockTag = document.getElementById('microLockTag');
    if (input) {
      if (isLocked) {
        input.setAttribute('readonly', '');
        input.classList.add('input-locked');
      } else {
        input.removeAttribute('readonly');
        input.classList.remove('input-locked');
      }
    }
    if (lockTag) {
      lockTag.style.display = isLocked ? 'inline' : 'none';
    }
    const btnBold = document.getElementById('btnMicroBold');
    if (btnBold) btnBold.disabled = !!isLocked;
    const btnFlag = document.getElementById('btnMicroFlag');
    if (btnFlag) btnFlag.disabled = !!isLocked;
    const btnAccept = document.getElementById('btnAcceptAiProposal');
    if (btnAccept) btnAccept.disabled = !!isLocked;
    const btnReject = document.getElementById('btnRejectAiProposal');
    if (btnReject) btnReject.disabled = !!isLocked;
  }

  function scaleCoordsForImg(coords, pageData, img) {
    if (!coords) return null;
    const norm = window.CropCanvas && typeof window.CropCanvas.normalizeBox === 'function'
      ? window.CropCanvas.normalizeBox(coords)
      : null;
    if (!norm) return null;
    const imgW = img.naturalWidth || img.width;
    const imgH = img.naturalHeight || img.height;
    const srcW = pageData && (pageData.imageWidth || pageData.w);
    const srcH = pageData && (pageData.imageHeight || pageData.h);
    if (!imgW || !imgH || !srcW || !srcH || (imgW === srcW && imgH === srcH)) {
      return norm;
    }
    const sx = imgW / srcW;
    const sy = imgH / srcH;
    return {
      x: norm.x * sx,
      y: norm.y * sy,
      width: norm.width * sx,
      height: norm.height * sy
    };
  }

  function renderLine() {
    const pageData = getPageContextData();
    if (!pageData || !pageData.lines[activeLineIdx]) return;

    const curPageId = getCurrentPageIdSafe(pageData);
    const isLocked = isSuggestMode()
      ? false
      : (window.ReviewSync && typeof window.ReviewSync.isPageEditable === 'function'
          ? !window.ReviewSync.isPageEditable(curPageId)
          : false);
    applyLockState(isLocked);

    const lines = pageData.lines;
    const totalLines = lines.length;
    const line = lines[activeLineIdx];
    const rawPrev = activeLineIdx > 0 ? lines[activeLineIdx - 1] : null;
    const rawNext = activeLineIdx < totalLines - 1 ? lines[activeLineIdx + 1] : null;
    const prevLine = (rawPrev && isSameSection(rawPrev, line)) ? rawPrev : null;
    const nextLine = (rawNext && isSameSection(rawNext, line)) ? rawNext : null;

    // Header label
    const label = document.getElementById('microLineLabel');
    if (label) {
      label.textContent = (customAdapter && typeof customAdapter.formatLineLabel === 'function')
        ? customAdapter.formatLineLabel(line, activeLineIdx, totalLines, pageData)
        : `Line ${activeLineIdx + 1} of ${totalLines}`;
    }

    // Context lines
    const startPlaceholder = (customAdapter && customAdapter.startLabel) || '— (תחילת עמוד) —';
    const endPlaceholder = (customAdapter && customAdapter.endLabel) || '— (סוף עמוד) —';
    const prevEl = document.getElementById('microPrevLine');
    if (prevEl) {
      const prevNum = prevLine && prevLine.displayIdx != null ? prevLine.displayIdx : activeLineIdx;
      prevEl.textContent = prevLine ? `[${prevNum}] ${prevLine.text}` : startPlaceholder;
    }

    const nextEl = document.getElementById('microNextLine');
    if (nextEl) {
      const nextNum = nextLine && nextLine.displayIdx != null ? nextLine.displayIdx : (activeLineIdx + 2);
      nextEl.textContent = nextLine ? `[${nextNum}] ${nextLine.text}` : endPlaceholder;
    }

    // Target input
    const input = document.getElementById('microTargetInput');
    if (input) {
      if (pendingDraftText !== null) {
        input.value = pendingDraftText;
        pendingDraftText = null;
      } else {
        input.value = line.text || '';
      }
      try {
        input.focus({ preventScroll: true });
      } catch (e) {
        input.focus();
      }
      // Caret at the end (not select-all), so the first keystroke can't wipe the line
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }

    if (!isSuggestMode()) renderVerifyState(line);

    // Canvas 3-line crop (auto-fitted to window / wrapper width)
    renderCropCanvas(prevLine, line, nextLine, pageData);

    // Check for AI Suggestions
    checkAiSuggestions(line.line_id);

    if (customAdapter && typeof customAdapter.onActiveLineChange === 'function') {
      customAdapter.onActiveLineChange(line, activeLineIdx, pageData);
    }
  }

  function renderVerifyState(line) {
    const btn = document.getElementById('btnMicroVerifyToggle');
    if (!btn) return;
    const verified = !!(line && line.verified);
    btn.classList.toggle('is-verified', verified);
    btn.setAttribute('aria-pressed', verified ? 'true' : 'false');
    btn.textContent = verified ? '✓ Verified' : '○ Not verified';
    btn.title = verified ? 'Verified — click to unverify' : 'Not verified — click to verify (or press Enter to verify & go to next line)';
  }

  function getActiveLine() {
    const pageData = getPageContextData();
    return (pageData && pageData.lines) ? pageData.lines[activeLineIdx] : null;
  }

  function setActiveVerified(value) {
    if (!window.MacroView || typeof window.MacroView.setLineVerified !== 'function') return;
    window.MacroView.setLineVerified(activeLineIdx, value);
    renderVerifyState(getActiveLine());
  }

  function toggleActiveVerified() {
    saveCurrentLine();
    const line = getActiveLine();
    if (line) setActiveVerified(!line.verified);
    document.getElementById('microTargetInput')?.focus();
  }

  function verifyAndNext() {
    const saveRes = saveCurrentLineInternal();
    if (saveRes.blocked) return;
    if (!isSuggestMode()) {
      const line = getActiveLine();
      if (line && !line.verified) setActiveVerified(true);
    }
    nextLine({ skipSave: true });
  }

  function renderCropCanvas(prevLine, line, nextLine, pageData) {
    if (!pageData) pageData = getPageContextData();
    if (!line) {
      if (!pageData || !pageData.lines || !pageData.lines[activeLineIdx]) return;
      const lines = pageData.lines;
      line = lines[activeLineIdx];
      const rawPrev = activeLineIdx > 0 ? lines[activeLineIdx - 1] : null;
      const rawNext = activeLineIdx < lines.length - 1 ? lines[activeLineIdx + 1] : null;
      prevLine = (rawPrev && isSameSection(rawPrev, line)) ? rawPrev : null;
      nextLine = (rawNext && isSameSection(rawNext, line)) ? rawNext : null;
    }

    const canvas = document.getElementById('cropCanvas');
    const wrapper = canvas ? canvas.closest('.canvas-crop-wrapper') : null;
    if (!canvas || !window.CropCanvas) return;

    const onImgLoad = () => {
      if (isOpen) renderCropCanvas();
    };
    const img = (customAdapter && typeof customAdapter.getScanImage === 'function')
      ? customAdapter.getScanImage(pageData, onImgLoad)
      : document.getElementById('manuscriptImg');

    const hasValidTarget = !!(line && line.coords && window.CropCanvas.normalizeBox(line.coords));
    if (!hasValidTarget) {
      canvas.width = 0;
      canvas.height = 0;
      canvas.style.width = '0px';
      canvas.style.height = '0px';
      if (wrapper) {
        wrapper.classList.remove('is-loading');
        wrapper.classList.add('is-empty');
      }
      return;
    }

    if (!img || (('complete' in img) && (!img.complete || !img.naturalWidth))) {
      canvas.width = 0;
      canvas.height = 0;
      canvas.style.width = '0px';
      canvas.style.height = '0px';
      if (wrapper) {
        wrapper.classList.remove('is-empty');
        wrapper.classList.add('is-loading');
      }
      return;
    }

    if (wrapper) {
      wrapper.classList.remove('is-loading');
      wrapper.classList.remove('is-empty');
    }

    const prevCoords = scaleCoordsForImg(prevLine ? prevLine.coords : null, pageData, img);
    const targetCoords = scaleCoordsForImg(line.coords, pageData, img);
    const nextCoords = scaleCoordsForImg(nextLine ? nextLine.coords : null, pageData, img);
    if (!targetCoords) return;

    const availWidth = wrapper && wrapper.clientWidth > 60
      ? wrapper.clientWidth - 24
      : Math.min(1340, Math.max(320, window.innerWidth - 64));
    window.CropCanvas.renderThreeLineCrop(
      canvas,
      img,
      prevCoords,
      targetCoords,
      nextCoords,
      {
        dpr: window.devicePixelRatio || 1,
        showGuides: true,
        maxWidth: availWidth,
        fitToWidth: true
      }
    );
  }

  function checkAiSuggestions(lineId) {
    const banner = document.getElementById('aiProposalBanner');
    if (!banner) return;

    currentProposal = null;
    banner.style.display = 'none';

    if (!isSuggestMode() && window.ReviewSync && window.MacroView) {
      const pageId = window.MacroView.getCurrentPageId();
      const suggestion = window.ReviewSync.getSuggestionForLine(pageId, lineId);
      if (suggestion && suggestion.status === 'pending') {
        currentProposal = suggestion;
        document.getElementById('aiProposalText').textContent = suggestion.proposed_text || '';
        document.getElementById('aiProposalReason').textContent = suggestion.reason || '';
        banner.style.display = 'flex';
      }
    }
  }

  function acceptAiProposal() {
    if (!currentProposal) return;
    const input = document.getElementById('microTargetInput');
    if (input && currentProposal.proposed_text) {
      input.value = currentProposal.proposed_text;
      input.focus();
    }

    if (window.ReviewSync) {
      const pageId = window.MacroView.getCurrentPageId();
      window.ReviewSync.setSuggestionStatus(pageId, currentProposal.id, 'accepted');
    }

    const banner = document.getElementById('aiProposalBanner');
    if (banner) banner.style.display = 'none';
    currentProposal = null;
  }

  function rejectAiProposal() {
    if (!currentProposal) return;
    if (window.ReviewSync) {
      const pageId = window.MacroView.getCurrentPageId();
      window.ReviewSync.setSuggestionStatus(pageId, currentProposal.id, 'rejected');
    }

    const banner = document.getElementById('aiProposalBanner');
    if (banner) banner.style.display = 'none';
    currentProposal = null;
  }

  function toggleAshuritBold() {
    const input = document.getElementById('microTargetInput');
    if (!input) return;

    const start = input.selectionStart;
    const end = input.selectionEnd;
    const val = input.value;

    if (start === end) {
      input.value = val.slice(0, start) + '****' + val.slice(end);
      input.selectionStart = input.selectionEnd = start + 2;
    } else {
      const selected = val.slice(start, end);
      if (selected.startsWith('**') && selected.endsWith('**') && selected.length >= 4) {
        const unwrapped = selected.slice(2, -2);
        input.value = val.slice(0, start) + unwrapped + val.slice(end);
        input.selectionStart = start;
        input.selectionEnd = start + unwrapped.length;
      } else {
        const wrapped = `**${selected}**`;
        input.value = val.slice(0, start) + wrapped + val.slice(end);
        input.selectionStart = start;
        input.selectionEnd = start + wrapped.length;
      }
    }
  }

  function validateBalancedBold(text) {
    const count = (text.match(/\*\*/g) || []).length;
    return count % 2 === 0;
  }

  function toggleWordFlag() {
    const input = document.getElementById('microTargetInput');
    if (!input) return;

    let start = input.selectionStart;
    let end = input.selectionEnd;
    const val = input.value;

    // If no text is selected, expand to surrounding non-whitespace word if cursor touches a word
    if (start === end) {
      let wStart = start;
      let wEnd = end;
      while (wStart > 0 && !/\s/.test(val[wStart - 1])) wStart--;
      while (wEnd < val.length && !/\s/.test(val[wEnd])) wEnd++;

      if (wStart < wEnd) {
        start = wStart;
        end = wEnd;
      } else {
        input.value = val.slice(0, start) + '????' + val.slice(end);
        input.focus();
        input.selectionStart = input.selectionEnd = start + 2;
        return;
      }
    }

    const selected = val.slice(start, end);
    if (selected.startsWith('??') && selected.endsWith('??') && selected.length >= 4) {
      const unwrapped = selected.slice(2, -2);
      input.value = val.slice(0, start) + unwrapped + val.slice(end);
      input.focus();
      input.selectionStart = start;
      input.selectionEnd = start + unwrapped.length;
    } else if (start >= 2 && end + 2 <= val.length && val.slice(start - 2, start) === '??' && val.slice(end, end + 2) === '??') {
      input.value = val.slice(0, start - 2) + selected + val.slice(end + 2);
      input.focus();
      input.selectionStart = start - 2;
      input.selectionEnd = end - 2;
    } else {
      const wrapped = `??${selected}??`;
      input.value = val.slice(0, start) + wrapped + val.slice(end);
      input.focus();
      input.selectionStart = start;
      input.selectionEnd = start + wrapped.length;
    }
  }

  function validateBalancedFlag(text) {
    const count = (text.match(/\?\?/g) || []).length;
    return count % 2 === 0;
  }

  // Saves the active line only if its text changed.
  function saveCurrentLineInternal(opts) {
    const pageData = getPageContextData();
    if (!pageData || !pageData.lines[activeLineIdx]) return { saved: false };

    const input = document.getElementById('microTargetInput');
    if (!input) return { saved: false };
    const newText = input.value.trim();
    const line = pageData.lines[activeLineIdx];
    const baseline = isSuggestMode()
      ? (line.origText != null ? line.origText : (line.text || '')).trim()
      : (line.text || '').trim();
    if (newText === baseline) return { saved: false, unchanged: true }; // unchanged: no write, no claim

    if (customAdapter && typeof customAdapter.onSaveLine === 'function') {
      const adapterRes = customAdapter.onSaveLine(line, newText, activeLineIdx, opts || {});
      if (adapterRes && adapterRes.blocked) {
        return { saved: false, blocked: true };
      }
      if (adapterRes === false) return { saved: false };
      line.text = newText;
      if (adapterRes && adapterRes.markSubmitted) {
        line.origText = newText;
      }
      return { saved: true };
    }

    const curPageId = getCurrentPageIdSafe(pageData);
    if (window.ReviewSync && typeof window.ReviewSync.isPageEditable === 'function' && !window.ReviewSync.isPageEditable(curPageId)) {
      console.warn(`[MicroView] Save blocked: ${curPageId} is claimed by another reviewer or locked.`);
      return { saved: false };
    }

    // Gate with passcode BEFORE mutating line in macro view or memory
    if (window.AuthGate && typeof window.AuthGate.checkPasscodeOrPrompt === 'function') {
      if (!window.AuthGate.checkPasscodeOrPrompt('🔒 Enter Reviewer Passcode to save edits:')) {
        // Revert input to existing line text if unauthorized
        const curLine = pageData.lines[activeLineIdx];
        if (input && curLine) input.value = curLine.text || '';
        return { saved: false };
      }
    }

    if (!validateBalancedBold(newText)) {
      alert('Note: Bold markdown asterisks (**) are not balanced on this line.');
    }
    if (!validateBalancedFlag(newText)) {
      alert('Note: Flag markers (??) are not balanced on this line.');
    }

    line.text = newText;

    // Text changed, so any earlier verification no longer applies
    if (window.MacroView) {
      window.MacroView.updateLineContent(activeLineIdx, newText, false);
    }

    if (window.ReviewSync) {
      window.ReviewSync.saveLine(curPageId, line.line_id, newText, false);
    }
    renderVerifyState(line);
    return { saved: true };
  }

  function saveCurrentLine() {
    return saveCurrentLineInternal().saved;
  }

  function handleCrossPageStep(direction, pageData) {
    if (!customAdapter || typeof customAdapter.onCrossPageStep !== 'function' || crossPageBusy) {
      if (direction === 'next') close(false);
      return;
    }
    crossPageBusy = true;
    Promise.resolve(customAdapter.onCrossPageStep(direction, pageData)).then((handled) => {
      crossPageBusy = false;
      if (!isOpen) return;
      if (handled) {
        const nextData = getPageContextData();
        const len = (nextData && nextData.lines) ? nextData.lines.length : 0;
        if (len > 0) {
          activeLineIdx = direction === 'prev' ? (len - 1) : 0;
          renderLine();
          return;
        }
      }
      if (direction === 'next') close(false);
    }, () => {
      crossPageBusy = false;
    });
  }

  function nextLine(opts) {
    if (!(opts && opts.skipSave)) {
      const res = saveCurrentLineInternal();
      if (res.blocked) return;
    }

    const pageData = getPageContextData();
    if (!pageData || !pageData.lines) return;

    if (activeLineIdx < pageData.lines.length - 1) {
      activeLineIdx++;
      renderLine();
    } else if (customAdapter && typeof customAdapter.onCrossPageStep === 'function') {
      handleCrossPageStep('next', pageData);
    } else {
      close(false);
    }
  }

  function prevLine(opts) {
    if (!(opts && opts.skipSave)) {
      const res = saveCurrentLineInternal();
      if (res.blocked) return;
    }
    if (activeLineIdx > 0) {
      activeLineIdx--;
      renderLine();
    } else if (customAdapter && typeof customAdapter.onCrossPageStep === 'function') {
      handleCrossPageStep('prev', getPageContextData());
    }
  }

  function bindDrawerControls() {
    const drawer = document.getElementById('microDrawer');
    if (!drawer || drawer.dataset.microBound === '1') return;
    drawer.dataset.microBound = '1';

    document.getElementById('btnCloseDrawer')?.addEventListener('click', () => close());
    document.getElementById('btnMicroVerifyToggle')?.addEventListener('click', toggleActiveVerified);
    document.getElementById('btnMicroVerifyNext')?.addEventListener('click', verifyAndNext);
    document.getElementById('btnMicroBold')?.addEventListener('mousedown', (e) => e.preventDefault());
    document.getElementById('btnMicroBold')?.addEventListener('click', toggleAshuritBold);
    document.getElementById('btnMicroFlag')?.addEventListener('mousedown', (e) => e.preventDefault());
    document.getElementById('btnMicroFlag')?.addEventListener('click', toggleWordFlag);
    document.getElementById('btnMicroNext')?.addEventListener('click', () => nextLine());
    document.getElementById('btnMicroPrevLine')?.addEventListener('click', () => prevLine());
    document.getElementById('btnAcceptAiProposal')?.addEventListener('click', acceptAiProposal);
    document.getElementById('btnRejectAiProposal')?.addEventListener('click', rejectAiProposal);
    document.getElementById('btnMicroFontDec')?.addEventListener('click', decMicroFontSize);
    document.getElementById('btnMicroFontInc')?.addEventListener('click', incMicroFontSize);
  }

  function setupEvents() {
    bindDrawerControls();
    initMicroFontSize();

    if (windowEventsBound) return;
    windowEventsBound = true;

    window.addEventListener('resize', () => {
      if (isOpen) renderCropCanvas();
    });

    // Key Listener when drawer is open
    window.addEventListener('keydown', (e) => {
      if (!isOpen) return;

      const drawer = document.getElementById('microDrawer');
      const outsideControl = drawer && e.target && !drawer.contains(e.target) &&
        /^(INPUT|TEXTAREA|SELECT|OPTION)$/i.test(e.target.tagName || '');

      // Esc to close (unless another modal dialog like #grid is open above)
      if (e.key === 'Escape') {
        if (document.querySelector('dialog[open]')) return;
        e.preventDefault();
        close();
        return;
      }

      if (outsideControl) return;

      // Cmd+B / Ctrl+B for Ashurit bold
      if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.code === 'KeyB')) {
        e.preventDefault();
        toggleAshuritBold();
        return;
      }

      // Cmd+/ or Ctrl+/ for Flag Word (??מילה??)
      if ((e.metaKey || e.ctrlKey) && (e.key === '/' || e.key === '?' || e.code === 'Slash')) {
        e.preventDefault();
        toggleWordFlag();
        return;
      }

      // Let Enter/Space activate a focused button normally (Close, Accept, etc.)
      const onButton = e.target && e.target.tagName === 'BUTTON';

      // Enter = Verify / Submit & next (saves first if changed)
      if (e.key === 'Enter' && !e.shiftKey && !onButton) {
        e.preventDefault();
        verifyAndNext();
        return;
      }

      // ↓ = save (if changed) & next, without verifying
      if (e.key === 'ArrowDown' || e.code === 'ArrowDown') {
        e.preventDefault();
        nextLine();
        return;
      }

      if (e.key === 'ArrowUp' || e.code === 'ArrowUp') {
        e.preventDefault();
        prevLine();
        return;
      }
    });
  }

  function configure(adapter) {
    customAdapter = adapter || null;
    setupEvents();
  }

  function getCurrentDraft() {
    const input = document.getElementById('microTargetInput');
    return {
      line: getActiveLine(),
      lineIdx: activeLineIdx,
      draftText: input ? input.value : ''
    };
  }

  document.addEventListener('DOMContentLoaded', setupEvents);

  return {
    configure,
    open,
    openForLineId,
    close,
    nextLine,
    prevLine,
    verifyAndNext,
    applyLockState,
    toggleAshuritBold,
    toggleWordFlag,
    validateBalancedBold,
    validateBalancedFlag,
    acceptAiProposal,
    rejectAiProposal,
    getMicroFontSize: () => microFontSize,
    incMicroFontSize,
    decMicroFontSize,
    applyMicroFontSize,
    refreshCrop: () => { if (isOpen) renderCropCanvas(); },
    getCurrentDraft,
    isOpen: () => isOpen,
    getActiveLineIdx: () => activeLineIdx
  };
})();
