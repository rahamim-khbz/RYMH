/**
 * micro_view.js
 * 
 * Manages the Focused 3-Line Inspection Drawer:
 * - High-magnification dynamic canvas slice (Line N-1, N, N+1)
 * - Focused target line editor with Ashurit bolding (Cmd+B / Ctrl+B)
 * - Pre-filled AI redline suggestions with Accept/Reject
 * - Arrow keys (↑ / ↓) navigate without saving
 * - Enter saves edit and advances (without modifying page verification state)
 */

window.MicroView = (function() {
  let activeLineIdx = 0;
  let isOpen = false;
  let currentProposal = null;
  let microFontSize = 22;

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

  function open(lineIdx) {
    const pageData = window.MacroView ? window.MacroView.getCurrentPageData() : null;
    if (!pageData || !pageData.lines || !pageData.lines[lineIdx]) return;

    // Check passcode gate before entering micro edit mode
    if (window.AuthGate && typeof window.AuthGate.checkPasscodeOrPrompt === 'function') {
      if (!window.AuthGate.checkPasscodeOrPrompt('🔒 Enter Reviewer Passcode to open line editor:')) {
        return;
      }
    }

    activeLineIdx = lineIdx;
    isOpen = true;

    const drawer = document.getElementById('microDrawer');
    if (drawer) drawer.classList.add('open');

    renderLine();
  }

  function close(saveIfDirty = true) {
    if (saveIfDirty) {
      const input = document.getElementById('microTargetInput');
      const pageData = window.MacroView ? window.MacroView.getCurrentPageData() : null;
      const line = (pageData && pageData.lines) ? pageData.lines[activeLineIdx] : null;
      if (input && line && input.value.trim() !== (line.text || '').trim()) {
        saveCurrentLine();
      }
    }

    isOpen = false;
    const drawer = document.getElementById('microDrawer');
    if (drawer) drawer.classList.remove('open');
    
    const row = document.getElementById(`line-row-${activeLineIdx}`);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
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

  function renderLine() {
    const pageData = window.MacroView ? window.MacroView.getCurrentPageData() : null;
    if (!pageData || !pageData.lines[activeLineIdx]) return;

    const curPageId = window.MacroView ? window.MacroView.getCurrentPageId() : 'page-05';
    const isLocked = window.ReviewSync && typeof window.ReviewSync.isPageEditable === 'function'
      ? !window.ReviewSync.isPageEditable(curPageId)
      : false;
    applyLockState(isLocked);

    const lines = pageData.lines;
    const totalLines = lines.length;
    const line = lines[activeLineIdx];
    const prevLine = activeLineIdx > 0 ? lines[activeLineIdx - 1] : null;
    const nextLine = activeLineIdx < totalLines - 1 ? lines[activeLineIdx + 1] : null;

    // Header label
    const label = document.getElementById('microLineLabel');
    if (label) label.textContent = `Line ${activeLineIdx + 1} of ${totalLines}`;

    // Context lines
    const prevEl = document.getElementById('microPrevLine');
    if (prevEl) prevEl.textContent = prevLine ? `[${activeLineIdx}] ${prevLine.text}` : '— (תחילת עמוד) —';

    const nextEl = document.getElementById('microNextLine');
    if (nextEl) nextEl.textContent = nextLine ? `[${activeLineIdx + 2}] ${nextLine.text}` : '— (סוף עמוד) —';

    // Target input
    const input = document.getElementById('microTargetInput');
    if (input) {
      input.value = line.text || '';
      input.focus();
      input.select();
    }

    // Canvas 3-line crop (auto-fitted to window / wrapper width)
    renderCropCanvas(prevLine, line, nextLine);

    // Check for AI Suggestions
    checkAiSuggestions(line.line_id);
  }

  function renderCropCanvas(prevLine, line, nextLine) {
    if (!line) {
      const pageData = window.MacroView ? window.MacroView.getCurrentPageData() : null;
      if (!pageData || !pageData.lines || !pageData.lines[activeLineIdx]) return;
      const lines = pageData.lines;
      line = lines[activeLineIdx];
      prevLine = activeLineIdx > 0 ? lines[activeLineIdx - 1] : null;
      nextLine = activeLineIdx < lines.length - 1 ? lines[activeLineIdx + 1] : null;
    }

    const canvas = document.getElementById('cropCanvas');
    const wrapper = canvas ? canvas.closest('.canvas-crop-wrapper') : null;
    const img = document.getElementById('manuscriptImg');
    if (canvas && img && window.CropCanvas) {
      const availWidth = wrapper && wrapper.clientWidth > 60
        ? wrapper.clientWidth - 24
        : Math.min(1340, Math.max(320, window.innerWidth - 64));
      window.CropCanvas.renderThreeLineCrop(
        canvas,
        img,
        prevLine ? prevLine.coords : null,
        line.coords,
        nextLine ? nextLine.coords : null,
        {
          dpr: window.devicePixelRatio || 1,
          showGuides: true,
          maxWidth: availWidth,
          fitToWidth: true
        }
      );
    }
  }

  function checkAiSuggestions(lineId) {
    const banner = document.getElementById('aiProposalBanner');
    if (!banner) return;

    currentProposal = null;
    banner.style.display = 'none';

    if (window.ReviewSync) {
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

  function saveCurrentLine() {
    const curPageId = window.MacroView ? window.MacroView.getCurrentPageId() : 'page-05';
    if (window.ReviewSync && typeof window.ReviewSync.isPageEditable === 'function' && !window.ReviewSync.isPageEditable(curPageId)) {
      console.warn(`[MicroView] Save blocked: ${curPageId} is claimed by another reviewer or locked.`);
      return;
    }

    const pageData = window.MacroView ? window.MacroView.getCurrentPageData() : null;
    if (!pageData || !pageData.lines[activeLineIdx]) return;

    const input = document.getElementById('microTargetInput');
    const newText = input ? input.value.trim() : '';

    // Gate with passcode BEFORE mutating line in macro view or memory
    if (window.AuthGate && typeof window.AuthGate.checkPasscodeOrPrompt === 'function') {
      if (!window.AuthGate.checkPasscodeOrPrompt('🔒 Enter Reviewer Passcode to save edits:')) {
        // Revert input to existing line text if unauthorized
        const line = pageData.lines[activeLineIdx];
        if (input && line) input.value = line.text || '';
        return;
      }
    }

    if (!validateBalancedBold(newText)) {
      alert('Note: Bold markdown asterisks (**) are not balanced on this line.');
    }
    if (!validateBalancedFlag(newText)) {
      alert('שים לב: סימוני הספק (??) אינם מאוזנים בשורה זו.');
    }

    const line = pageData.lines[activeLineIdx];
    line.text = newText;

    // Update macro view text (preserves line.verified, marks line as edited)
    if (window.MacroView) {
      window.MacroView.updateLineContent(activeLineIdx, newText);
    }

    if (window.ReviewSync) {
      const pageId = window.MacroView.getCurrentPageId();
      window.ReviewSync.saveLine(pageId, line.line_id, newText, !!line.verified);
    }
  }

  function nextLine(save = true) {
    if (save) saveCurrentLine();

    const pageData = window.MacroView ? window.MacroView.getCurrentPageData() : null;
    if (!pageData) return;

    if (activeLineIdx < pageData.lines.length - 1) {
      activeLineIdx++;
      renderLine();
    } else {
      close();
    }
  }

  function prevLine(save = true) {
    if (save) saveCurrentLine();

    if (activeLineIdx > 0) {
      activeLineIdx--;
      renderLine();
    }
  }

  function setupEvents() {
    document.getElementById('btnCloseDrawer')?.addEventListener('click', close);
    document.getElementById('btnMicroBold')?.addEventListener('mousedown', (e) => e.preventDefault());
    document.getElementById('btnMicroBold')?.addEventListener('click', toggleAshuritBold);
    document.getElementById('btnMicroFlag')?.addEventListener('mousedown', (e) => e.preventDefault());
    document.getElementById('btnMicroFlag')?.addEventListener('click', toggleWordFlag);
    document.getElementById('btnMicroNext')?.addEventListener('click', () => nextLine(true));
    document.getElementById('btnMicroPrevLine')?.addEventListener('click', () => prevLine(true));
    document.getElementById('btnAcceptAiProposal')?.addEventListener('click', acceptAiProposal);
    document.getElementById('btnRejectAiProposal')?.addEventListener('click', rejectAiProposal);
    document.getElementById('btnMicroFontDec')?.addEventListener('click', decMicroFontSize);
    document.getElementById('btnMicroFontInc')?.addEventListener('click', incMicroFontSize);

    initMicroFontSize();

    window.addEventListener('resize', () => {
      if (isOpen) renderCropCanvas();
    });

    // Key Listener when drawer is open
    window.addEventListener('keydown', (e) => {
      if (!isOpen) return;

      // Esc to close
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }

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

      // Enter saves edit & moves to next
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        nextLine(true);
        return;
      }

      // Up and Down arrow keys move lines and save edits
      if (e.key === 'ArrowDown' || e.code === 'ArrowDown') {
        e.preventDefault();
        nextLine(true);
        return;
      }

      if (e.key === 'ArrowUp' || e.code === 'ArrowUp') {
        e.preventDefault();
        prevLine(true);
        return;
      }
    });
  }

  document.addEventListener('DOMContentLoaded', setupEvents);

  return {
    open,
    close,
    nextLine,
    prevLine,
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
    isOpen: () => isOpen,
    getActiveLineIdx: () => activeLineIdx
  };
})();
