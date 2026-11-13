/**
 * macro_view.js
 * 
 * Manages the In-Situ Full-Page Macro View:
 * - Manuscript scan pan/zoom interaction with cursor-centered wheel zoom
 * - Theme switcher (Dark / Sepia / Light)
 * - Font-size controls with single-line fitting
 * - Continuous line stream rendering with inline paragraph break symbols (¶)
 * - Line verification toggle (✓) and edited status indicator ([Edited])
 * - Dispatches to MicroView on double-click or [🖼️] click
 */

window.MacroView = (function() {
  let currentPageId = 'page-05';
  let currentPageData = null;
  let zoomLevel = 1.0;
  let panX = 0;
  let panY = 0;
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let currentFontSize = 18;
  const THEMES = ['dark', 'sepia', 'light'];
  const THEME_LABELS = { dark: '🌙 Dark', sepia: '📜 Sepia', light: '☀️ Light' };

  function hasFlaggedWords(rawText) {
    if (!rawText) return false;
    return /\?\?(.+?)\?\?/.test(rawText);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatMarkup(rawText) {
    if (!rawText) return '';
    let escaped = escapeHtml(rawText);
    escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    escaped = escaped.replace(/\?\?(.*?)\?\?/g, '<span class="flagged-word" title="מסומן לבדיקה נוספת">$1</span>');
    escaped = escaped.replace(/(?:\(([א-ת*])\)|\[\^([א-ת*])\])/g, '<span class="fn-ref">($1$2)</span>');
    return escaped;
  }

  function parsePageParam() {
    const params = new URLSearchParams(window.location.search);
    const p = params.get('page');
    if (!p) return 'page-05';
    if (p.startsWith('page-')) return p;
    const num = parseInt(p, 10);
    if (!isNaN(num)) {
      return `page-${String(num).padStart(2, '0')}`;
    }
    return 'page-05';
  }

  // --- Themes ---
  function initTheme() {
    const savedTheme = localStorage.getItem('ih_theme') || 'dark';
    applyTheme(savedTheme);

    const btn = document.getElementById('btnThemeToggle');
    if (btn) {
      btn.addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme') || 'dark';
        const nextIdx = (THEMES.indexOf(cur) + 1) % THEMES.length;
        const nextTheme = THEMES[nextIdx];
        applyTheme(nextTheme);
      });
    }
  }

  function applyTheme(theme) {
    if (!THEMES.includes(theme)) theme = 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ih_theme', theme);
    const btn = document.getElementById('btnThemeToggle');
    if (btn) btn.textContent = THEME_LABELS[theme] || theme;
  }

  // --- Font Size Controls ---
  function initFontSize() {
    const saved = localStorage.getItem('ih_font_size');
    if (saved) {
      const n = parseInt(saved, 10);
      if (!isNaN(n) && n >= 12 && n <= 32) currentFontSize = n;
    }
    applyFontSize();

    document.getElementById('btnFontDec')?.addEventListener('click', () => {
      if (currentFontSize > 13) {
        currentFontSize -= 1;
        applyFontSize();
      }
    });

    document.getElementById('btnFontInc')?.addEventListener('click', () => {
      if (currentFontSize < 32) {
        currentFontSize += 1;
        applyFontSize();
      }
    });
  }

  function applyFontSize() {
    document.documentElement.style.setProperty('--font-size-text', `${currentFontSize}px`);
    localStorage.setItem('ih_font_size', String(currentFontSize));
    const disp = document.getElementById('fontSizeDisplay');
    if (disp) disp.textContent = `${currentFontSize}px`;
  }

  async function loadPage(pageId) {
    currentPageId = pageId;
    document.getElementById('pageTitleLabel').textContent = `Page ${pageId.replace('page-', '')}`;
    
    const sel = document.getElementById('pageSelector');
    if (sel) sel.value = pageId;

    try {
      const res = await fetch(`review_data/${pageId}.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      currentPageData = await res.json();
    } catch (err) {
      console.error('Failed to load review data:', err);
      return;
    }

    // Preserve original text for change detection
    if (currentPageData.lines) {
      currentPageData.lines.forEach(l => {
        if (l.original_text === undefined) {
          l.original_text = l.text;
        }
      });
    }

    // Set manuscript image
    const img = document.getElementById('manuscriptImg');
    if (img && currentPageData.image) {
      const imgSrc = currentPageData.image.startsWith('/') ? currentPageData.image.slice(1) : currentPageData.image;
      img.src = imgSrc;
      img.onload = () => {
        fitImageToWidth();
      };
    }

    renderLines();
    if (window.ReviewSync) {
      await window.ReviewSync.initPage(pageId, currentPageData);
    }

    // Check if deep-linked to a specific line (?line=<line_id_or_idx>)
    const params = new URLSearchParams(window.location.search);
    const targetLineParam = params.get('line') || params.get('line_id');
    if (targetLineParam && currentPageData && currentPageData.lines && window.MicroView) {
      let targetIdx = -1;
      if (/^\d+$/.test(targetLineParam)) {
        targetIdx = parseInt(targetLineParam, 10);
      } else {
        targetIdx = currentPageData.lines.findIndex(l => l.line_id === targetLineParam);
      }
      if (targetIdx >= 0 && targetIdx < currentPageData.lines.length) {
        const row = document.getElementById(`line-row-${targetIdx}`);
        if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        window.MicroView.open(targetIdx);
      }
    }
  }

  function renderLines() {
    const container = document.getElementById('linesContainer');
    if (!container || !currentPageData) return;
    container.innerHTML = '';

    const isLocked = window.ReviewSync && typeof window.ReviewSync.isPageEditable === 'function'
      ? !window.ReviewSync.isPageEditable(currentPageId)
      : false;

    container.classList.toggle('page-locked', isLocked);

    const lines = currentPageData.lines || [];
    lines.forEach((line, idx) => {
      const row = document.createElement('div');
      row.className = 'review-line-row';
      row.id = `line-row-${idx}`;
      row.dataset.lineId = line.line_id;
      row.dataset.lineIdx = idx;
      row.dataset.lineKind = line.kind || 'main';

      const isEdited = line.original_text !== undefined && line.text !== line.original_text;
      if (isEdited) row.classList.add('edited');
      if (line.verified) row.classList.add('verified');

      const isFlagged = !!line.flagged || hasFlaggedWords(line.text);
      if (isFlagged) row.classList.add('flagged');

      if (line.para_start) {
        row.classList.add('para-start');
      }

      // Meta margin (Line Number, [🖼️] button, [✓] Verify toggle)
      const meta = document.createElement('div');
      meta.className = 'line-meta';

      // Verify toggle button on page view
      const btnVerify = document.createElement('button');
      btnVerify.className = 'btn-verify-line';
      btnVerify.innerHTML = '✓';
      btnVerify.title = line.verified ? 'Verified (click to unverify)' : 'Click to verify this line';
      btnVerify.setAttribute('aria-pressed', line.verified ? 'true' : 'false');
      btnVerify.setAttribute('aria-label', 'Verified');
      btnVerify.disabled = isLocked;
      btnVerify.onclick = (e) => {
        e.stopPropagation();
        toggleLineVerification(idx);
      };
      meta.appendChild(btnVerify);

      // Line number
      const idxSpan = document.createElement('span');
      idxSpan.className = 'line-idx-num';
      idxSpan.textContent = idx + 1;
      meta.appendChild(idxSpan);

      // 3-Line Zoom Drawer Button
      const btnZoom = document.createElement('button');
      btnZoom.className = 'btn-crop-zoom';
      btnZoom.innerHTML = '🖼️';
      btnZoom.title = 'Open 3-line inspection (Double-click)';
      btnZoom.onclick = (e) => {
        e.stopPropagation();
        if (window.MicroView) window.MicroView.open(idx);
      };
      meta.appendChild(btnZoom);

      // Edited Badge
      const editedBadge = document.createElement('span');
      editedBadge.className = 'edited-badge';
      editedBadge.textContent = 'Edited';
      meta.appendChild(editedBadge);

      // Flagged Badge
      const flaggedBadge = document.createElement('span');
      flaggedBadge.className = 'flagged-badge';
      flaggedBadge.textContent = '🚩 לבדיקה';
      flaggedBadge.title = 'שורה זו מכילה מילה המסומנת לבדיקה נוספת (??מילה??)';
      meta.appendChild(flaggedBadge);

      // Catchword Badge
      if (line.is_catchword) {
        row.classList.add('catchword-row');
        const cwBadge = document.createElement('span');
        cwBadge.className = 'catchword-badge';
        cwBadge.textContent = 'Catchword';
        cwBadge.title = 'Bottom catchword anticipating the opening of the next page';
        meta.appendChild(cwBadge);
      }

      row.appendChild(meta);

      // Editable line text (single-line default, disabled if page is locked)
      const textDiv = document.createElement('div');
      textDiv.className = 'line-text';
      textDiv.contentEditable = isLocked ? 'false' : 'true';
      textDiv.spellcheck = false;
      textDiv.innerHTML = formatMarkup(line.text);

      textDiv.addEventListener('focus', () => {
        document.querySelectorAll('.review-line-row.active').forEach(r => r.classList.remove('active'));
        row.classList.add('active');
      });

      textDiv.addEventListener('input', () => {
        if (window.ReviewSync && typeof window.ReviewSync.isPageEditable === 'function' && !window.ReviewSync.isPageEditable(currentPageId)) {
          return;
        }
        const raw = (typeof domToMarkdown === 'function' ? domToMarkdown(textDiv) : textDiv.innerText).replace(/\n/g, ' ').trim();
        if (raw === (line.text || '').trim()) return; // no real change: no write
        line.text = raw;
        line.flagged = hasFlaggedWords(raw);
        const nowEdited = line.original_text !== undefined && raw !== line.original_text;
        row.classList.toggle('edited', nowEdited);
        row.classList.toggle('flagged', line.flagged);
        clearVerifiedOnEdit(line, row);

        if (window.ReviewSync) {
          window.ReviewSync.saveLine(currentPageId, line.line_id, raw, false);
        }
      });

      // Double-click opens micro view
      row.addEventListener('dblclick', () => {
        if (window.MicroView) window.MicroView.open(idx);
      });

      row.appendChild(textDiv);
      container.appendChild(row);
    });
  }

  function applyLockState(isLocked) {
    const container = document.getElementById('linesContainer');
    if (container) {
      container.classList.toggle('page-locked', !!isLocked);
      container.querySelectorAll('.line-text').forEach(el => {
        el.contentEditable = isLocked ? 'false' : 'true';
      });
      container.querySelectorAll('.btn-verify-line').forEach(btn => {
        btn.disabled = !!isLocked;
      });
    }
    const btnBold = document.getElementById('btnMacroBoldSelected');
    if (btnBold) btnBold.disabled = !!isLocked;
    const btnFlag = document.getElementById('btnMacroFlagSelected');
    if (btnFlag) btnFlag.disabled = !!isLocked;
    const btnComplete = document.getElementById('btnCompletePage');
    if (btnComplete) btnComplete.disabled = !!isLocked;
  }

  function renderRowVerified(row, verified) {
    if (!row) return;
    row.classList.toggle('verified', !!verified);
    const btn = row.querySelector('.btn-verify-line');
    if (btn) {
      btn.title = verified ? 'Verified (click to unverify)' : 'Click to verify this line';
      btn.setAttribute('aria-pressed', verified ? 'true' : 'false');
    }
  }

  // A text change invalidates any earlier verification
  function clearVerifiedOnEdit(line, row) {
    if (!line.verified) return;
    line.verified = false;
    renderRowVerified(row, false);
  }

  function setLineVerified(idx, value) {
    if (!currentPageData || !currentPageData.lines[idx]) return false;
    if (window.ReviewSync && typeof window.ReviewSync.isPageEditable === 'function' && !window.ReviewSync.isPageEditable(currentPageId)) {
      console.warn(`Verification change blocked: ${currentPageId} is locked.`);
      return false;
    }
    const line = currentPageData.lines[idx];
    line.verified = !!value;
    renderRowVerified(document.getElementById(`line-row-${idx}`), line.verified);

    if (window.ReviewSync) {
      window.ReviewSync.saveLine(currentPageId, line.line_id, line.text, line.verified);
    }
    return true;
  }

  function toggleLineVerification(idx) {
    if (!currentPageData || !currentPageData.lines[idx]) return;
    setLineVerified(idx, !currentPageData.lines[idx].verified);
  }

  function updateLineContent(idx, newText, isVerified = null) {
    if (!currentPageData || !currentPageData.lines[idx]) return;
    const line = currentPageData.lines[idx];
    line.text = newText;
    line.flagged = hasFlaggedWords(newText);
    if (isVerified !== null) {
      line.verified = isVerified;
    }

    const isEdited = line.original_text !== undefined && line.text !== line.original_text;

    const row = document.getElementById(`line-row-${idx}`);
    if (row) {
      const textDiv = row.querySelector('.line-text');
      if (textDiv) textDiv.innerHTML = formatMarkup(newText);
      row.classList.toggle('edited', isEdited);
      row.classList.toggle('flagged', line.flagged);
      if (isVerified !== null) {
        renderRowVerified(row, line.verified);
      }
    }
  }

  // --- Pan & Zoom with Cursor-Centered Wheel Zoom ---
  function setupImageControls() {
    const viewport = document.getElementById('imageViewport');
    const img = document.getElementById('manuscriptImg');
    if (!viewport || !img) return;

    function applyTransform() {
      img.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`;
    }

    window.fitImageToWidth = function() {
      if (!img.naturalWidth) return;
      const vpWidth = viewport.clientWidth;
      zoomLevel = Math.max(0.15, (vpWidth - 40) / img.naturalWidth);
      panX = 20;
      panY = 20;
      applyTransform();
    };

    function zoomAroundPoint(factor, clientX, clientY) {
      const rect = viewport.getBoundingClientRect();
      const mouseX = clientX - rect.left;
      const mouseY = clientY - rect.top;

      // Image coordinates under cursor before zoom
      const imgX = (mouseX - panX) / zoomLevel;
      const imgY = (mouseY - panY) / zoomLevel;

      // New zoom level
      const newZoom = Math.min(4.5, Math.max(0.15, zoomLevel * factor));

      // Adjust pan so point under cursor stays at mouseX, mouseY
      panX = mouseX - imgX * newZoom;
      panY = mouseY - imgY * newZoom;
      zoomLevel = newZoom;

      applyTransform();
    }

    document.getElementById('btnZoomIn')?.addEventListener('click', () => {
      const rect = viewport.getBoundingClientRect();
      zoomAroundPoint(1.25, rect.left + rect.width / 2, rect.top + rect.height / 2);
    });

    document.getElementById('btnZoomOut')?.addEventListener('click', () => {
      const rect = viewport.getBoundingClientRect();
      zoomAroundPoint(0.8, rect.left + rect.width / 2, rect.top + rect.height / 2);
    });

    document.getElementById('btnZoomFit')?.addEventListener('click', () => {
      window.fitImageToWidth();
    });

    document.getElementById('btnZoom100')?.addEventListener('click', () => {
      zoomLevel = 1.0;
      panX = 20;
      panY = 20;
      applyTransform();
    });

    // Drag to pan
    viewport.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      dragStartX = e.clientX - panX;
      dragStartY = e.clientY - panY;
      viewport.classList.add('grabbing');
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      panX = e.clientX - dragStartX;
      panY = e.clientY - dragStartY;
      applyTransform();
    });

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        viewport.classList.remove('grabbing');
      }
    });

    // Cursor-centered mouse wheel zoom
    viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : (1 / 1.15);
      zoomAroundPoint(factor, e.clientX, e.clientY);
    }, { passive: false });
  }

  function setupPageNavigation() {
    const sel = document.getElementById('pageSelector');
    if (sel) {
      sel.innerHTML = '';
      for (let i = 1; i <= 89; i++) {
        const pid = `page-${String(i).padStart(2, '0')}`;
        const opt = document.createElement('option');
        opt.value = pid;
        opt.textContent = `Page ${i}`;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => {
        window.history.pushState(null, '', `?page=${sel.value}`);
        loadPage(sel.value);
      });
    }

    document.getElementById('btnPrevPage')?.addEventListener('click', () => {
      const currentNum = parseInt(currentPageId.replace('page-', ''), 10);
      if (currentNum > 1) {
        const prevId = `page-${String(currentNum - 1).padStart(2, '0')}`;
        window.history.pushState(null, '', `?page=${prevId}`);
        loadPage(prevId);
      }
    });

    document.getElementById('btnNextPage')?.addEventListener('click', () => {
      const currentNum = parseInt(currentPageId.replace('page-', ''), 10);
      if (currentNum < 89) {
        const nextId = `page-${String(currentNum + 1).padStart(2, '0')}`;
        window.history.pushState(null, '', `?page=${nextId}`);
        loadPage(nextId);
      }
    });
  }

  function domToMarkdown(node) {
    if (!node) return '';
    if (node.nodeType === 3) {
      return node.nodeValue || '';
    }
    if (node.nodeType === 1) {
      const tag = node.tagName ? node.tagName.toLowerCase() : '';
      if (tag === 'strong' || tag === 'b') {
        const inner = node.childNodes && node.childNodes.length > 0
          ? Array.from(node.childNodes).map(domToMarkdown).join('')
          : (node.textContent || '');
        return `**${inner}**`;
      }
      if (tag === 'span' && node.classList && node.classList.contains('flagged-word')) {
        const inner = node.childNodes && node.childNodes.length > 0
          ? Array.from(node.childNodes).map(domToMarkdown).join('')
          : (node.textContent || '');
        return `??${inner}??`;
      }
      if (tag === 'span' && node.classList && node.classList.contains('fn-ref')) {
        return node.childNodes && node.childNodes.length > 0
          ? Array.from(node.childNodes).map(domToMarkdown).join('')
          : (node.textContent || '');
      }
      if (tag === 'br') {
        return ' ';
      }
      if (node.childNodes && node.childNodes.length > 0) {
        return Array.from(node.childNodes).map(domToMarkdown).join('');
      }
      return node.innerText || node.textContent || '';
    }
    return node.innerText || node.textContent || '';
  }

  function toggleMarkdownInElement(targetTextDiv, targetIdx, marker) {
    if (!currentPageData || !currentPageData.lines || !currentPageData.lines[targetIdx]) return;
    const line = currentPageData.lines[targetIdx];

    const sel = (typeof window !== 'undefined' && window.getSelection) ? window.getSelection() : null;

    let applied = false;
    if (sel && sel.anchorNode && targetTextDiv.contains && targetTextDiv.contains(sel.anchorNode)) {
      if (sel.isCollapsed && sel.anchorNode.nodeType === 3) {
        const parentTag = sel.anchorNode.parentElement ? sel.anchorNode.parentElement.tagName.toLowerCase() : '';
        const isParentStrong = parentTag === 'strong' || parentTag === 'b';
        const isParentFlag = sel.anchorNode.parentElement && sel.anchorNode.parentElement.classList && sel.anchorNode.parentElement.classList.contains('flagged-word');

        if (marker === '**' && isParentStrong) {
          const el = sel.anchorNode.parentElement;
          const p = el.parentNode;
          while (el.firstChild) p.insertBefore(el.firstChild, el);
          p.removeChild(el);
          applied = true;
        } else if (marker === '??' && isParentFlag) {
          const el = sel.anchorNode.parentElement;
          const p = el.parentNode;
          while (el.firstChild) p.insertBefore(el.firstChild, el);
          p.removeChild(el);
          applied = true;
        } else if (typeof document !== 'undefined' && document.createRange) {
          const text = sel.anchorNode.nodeValue || '';
          let wStart = sel.anchorOffset;
          let wEnd = sel.anchorOffset;
          while (wStart > 0 && !/\s/.test(text[wStart - 1])) wStart--;
          while (wEnd < text.length && !/\s/.test(text[wEnd])) wEnd++;
          if (wStart < wEnd) {
            const range = document.createRange();
            range.setStart(sel.anchorNode, wStart);
            range.setEnd(sel.anchorNode, wEnd);
            sel.removeAllRanges();
            sel.addRange(range);
          }
        }
      }

      if (!applied && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const selText = sel.toString();
        const parent = sel.anchorNode.parentElement;
        const strongEl = parent && parent.closest ? parent.closest('strong, b') : null;
        const flagEl = parent && parent.closest ? parent.closest('.flagged-word') : null;

        if (marker === '**' && strongEl && targetTextDiv.contains(strongEl)) {
          const p = strongEl.parentNode;
          while (strongEl.firstChild) p.insertBefore(strongEl.firstChild, strongEl);
          p.removeChild(strongEl);
          applied = true;
        } else if (marker === '??' && flagEl && targetTextDiv.contains(flagEl)) {
          const p = flagEl.parentNode;
          while (flagEl.firstChild) p.insertBefore(flagEl.firstChild, flagEl);
          p.removeChild(flagEl);
          applied = true;
        } else if (selText && selText.length > 0) {
          const wrapper = document.createElement(marker === '**' ? 'strong' : 'span');
          if (marker === '??') {
            wrapper.className = 'flagged-word';
            wrapper.title = 'מסומן לבדיקה נוספת';
          }
          try {
            range.surroundContents(wrapper);
          } catch (e) {
            const frag = range.extractContents();
            wrapper.appendChild(frag);
            range.insertNode(wrapper);
          }
          applied = true;
        }
      }
    }

    let newRaw = '';
    if (applied) {
      newRaw = domToMarkdown(targetTextDiv).replace(/\n/g, ' ').trim();
    } else {
      const curText = line.text || targetTextDiv.innerText || '';
      if (marker === '**') {
        if (curText.startsWith('**') && curText.endsWith('**') && curText.length >= 4) {
          newRaw = curText.slice(2, -2);
        } else {
          newRaw = `**${curText}**`;
        }
      } else if (marker === '??') {
        if (curText.startsWith('??') && curText.endsWith('??') && curText.length >= 4) {
          newRaw = curText.slice(2, -2);
        } else {
          newRaw = `??${curText}??`;
        }
      }
      targetTextDiv.innerHTML = formatMarkup(newRaw);
    }

    const changed = newRaw !== line.text;
    line.text = newRaw;
    line.flagged = hasFlaggedWords(newRaw);
    const row = document.getElementById(`line-row-${targetIdx}`);
    if (row) {
      const nowEdited = line.original_text !== undefined && newRaw !== line.original_text;
      row.classList.toggle('edited', nowEdited);
      row.classList.toggle('flagged', line.flagged);
    }
    if (changed) clearVerifiedOnEdit(line, row);
    if (window.ReviewSync && changed) {
      window.ReviewSync.saveLine(currentPageId, line.line_id, newRaw, !!line.verified);
    }
  }

  function applySelectionAction(marker) {
    if (!currentPageData || !currentPageData.lines) return;
    if (window.ReviewSync && typeof window.ReviewSync.isPageEditable === 'function' && !window.ReviewSync.isPageEditable(currentPageId)) {
      console.warn(`Formatting blocked: ${currentPageId} is locked.`);
      return;
    }
    let targetTextDiv = null;
    let targetIdx = -1;

    const sel = (typeof window !== 'undefined' && window.getSelection) ? window.getSelection() : null;
    if (sel && sel.anchorNode) {
      let node = sel.anchorNode;
      while (node && node !== document.body) {
        if (node.nodeType === 1 && node.classList && node.classList.contains('line-text')) {
          targetTextDiv = node;
          const row = node.closest ? node.closest('.review-line-row') : null;
          if (row) {
            if (row.dataset && row.dataset.lineIdx !== undefined) {
              targetIdx = parseInt(row.dataset.lineIdx, 10);
            } else if (row.id && row.id.startsWith('line-row-')) {
              targetIdx = parseInt(row.id.replace('line-row-', ''), 10);
            }
          }
          break;
        }
        node = node.parentNode;
      }
    }

    if (!targetTextDiv || targetIdx < 0) {
      const activeRow = (typeof document !== 'undefined' && document.querySelector)
        ? (document.querySelector('.review-line-row.active') || document.querySelector('.review-line-row'))
        : null;
      if (activeRow) {
        targetTextDiv = activeRow.querySelector ? activeRow.querySelector('.line-text') : null;
        if (activeRow.dataset && activeRow.dataset.lineIdx !== undefined) {
          targetIdx = parseInt(activeRow.dataset.lineIdx, 10);
        } else if (activeRow.id && activeRow.id.startsWith('line-row-')) {
          targetIdx = parseInt(activeRow.id.replace('line-row-', ''), 10);
        }
      }
    }

    if (targetTextDiv && targetIdx >= 0) {
      toggleMarkdownInElement(targetTextDiv, targetIdx, marker);
    }
  }

  function setupToolbarSelectionEvents() {
    const btnBold = document.getElementById('btnMacroBoldSelected');
    if (btnBold) {
      btnBold.addEventListener('mousedown', (e) => e.preventDefault());
      btnBold.addEventListener('click', () => applySelectionAction('**'));
    }

    const btnFlag = document.getElementById('btnMacroFlagSelected');
    if (btnFlag) {
      btnFlag.addEventListener('mousedown', (e) => e.preventDefault());
      btnFlag.addEventListener('click', () => applySelectionAction('??'));
    }

    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('keydown', (e) => {
        if (window.MicroView && typeof window.MicroView.isOpen === 'function' && window.MicroView.isOpen()) {
          return;
        }

        if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.code === 'KeyB')) {
          const activeText = (typeof document !== 'undefined' && document.querySelector)
            ? (document.querySelector('.line-text:focus') || document.querySelector('.review-line-row.active .line-text'))
            : null;
          if (activeText) {
            e.preventDefault();
            applySelectionAction('**');
          }
        }

        if ((e.metaKey || e.ctrlKey) && (e.key === '/' || e.key === '?' || e.code === 'Slash')) {
          const activeText = (typeof document !== 'undefined' && document.querySelector)
            ? (document.querySelector('.line-text:focus') || document.querySelector('.review-line-row.active .line-text'))
            : null;
          if (activeText) {
            e.preventDefault();
            applySelectionAction('??');
          }
        }
      });
    }
  }

  function init() {
    // Hide Editorial Hub on static GitHub Pages hosting (or static server without flask backend)
    if (window.location.hostname.endsWith('github.io') || window.location.protocol === 'file:' || window.location.pathname.endsWith('.html')) {
      const edHub = document.getElementById('navEditorialHub');
      if (edHub) edHub.style.display = 'none';
    }

    initTheme();
    initFontSize();
    setupImageControls();
    setupPageNavigation();
    setupToolbarSelectionEvents();

    const pid = parsePageParam();
    loadPage(pid);
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    init,
    loadPage,
    renderLines,
    applyLockState,
    domToMarkdown,
    updateLineContent,
    setLineVerified,
    toggleLineVerification,
    applySelectionAction,
    formatMarkup,
    hasFlaggedWords,
    getCurrentPageData: () => currentPageData,
    getCurrentPageId: () => currentPageId
  };
})();
