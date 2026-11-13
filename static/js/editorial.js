/**
 * editorial.js
 * Frontend logic for the Editorial Review Hub:
 * - Fetches editorial summary from /api/editorial/summary
 * - Renders Flagged Open Questions with 3-line manuscript scan crop previews
 * - Resolves open questions inline via /api/editorial/resolve_flag
 * - Renders Submitted Folio Diffs with word-level LCS highlighting
 * - Merges approved pages to canonical via /api/editorial/merge_page
 */

(function() {
  let summaryData = {
    stats: {},
    flagged_questions: [],
    submitted_pages: []
  };

  let activeTab = 'questions';
  let searchTerm = '';
  let filterKind = 'all';

  // -------------------------------------------------------------
  // Theme Management
  // -------------------------------------------------------------
  const THEMES = ['dark', 'sepia', 'light'];
  function initTheme() {
    const saved = localStorage.getItem('review_theme') || 'dark';
    applyTheme(saved);

    const toggleBtn = document.getElementById('editorialThemeToggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme') || 'dark';
        const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
        applyTheme(next);
      });
    }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('review_theme', theme);
    const btn = document.getElementById('editorialThemeToggle');
    if (btn) {
      const labels = { dark: '🌙 Dark', sepia: '📜 Sepia', light: '☀️ Light' };
      btn.textContent = labels[theme] || '🌙 Dark';
    }
  }

  // -------------------------------------------------------------
  // Word-Level LCS Diff Algorithm
  // -------------------------------------------------------------
  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // URL path segment, safe to embed in an HTML attribute
  function seg(v) {
    return escapeHtml(encodeURIComponent(String(v == null ? '' : v)));
  }

  // RTDB keys can contain quotes, angle brackets and spaces; only accept boring ids.
  const SAFE_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
  function isSafeKey(k) {
    return typeof k === 'string' && SAFE_KEY_RE.test(k);
  }

  function formatContextSentence(rawText) {
    let safe = escapeHtml(rawText || '');
    safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/\?\?(.+?)\?\?/g, '<mark class="doubt-word-mark" title="Flagged doubtful word">🚩 $1</mark>');
    return safe;
  }

  function computeWordDiff(origText, newText) {
    if (!origText && !newText) return '';
    if (!origText) return `<ins class="diff-ins">${escapeHtml(newText)}</ins>`;
    if (!newText) return `<del class="diff-del">${escapeHtml(origText)}</del>`;

    const origTokens = origText.trim().split(/\s+/);
    const newTokens = newText.trim().split(/\s+/);

    const m = origTokens.length;
    const n = newTokens.length;

    // Build LCS matrix
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < n; j++) {
        if (origTokens[i] === newTokens[j]) {
          dp[i + 1][j + 1] = dp[i][j] + 1;
        } else {
          dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }

    // Backtrack to build diff tokens
    let i = m;
    let j = n;
    const diffs = [];

    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && origTokens[i - 1] === newTokens[j - 1]) {
        diffs.unshift({ type: 'equal', text: origTokens[i - 1] });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        diffs.unshift({ type: 'insert', text: newTokens[j - 1] });
        j--;
      } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
        diffs.unshift({ type: 'delete', text: origTokens[i - 1] });
        i--;
      }
    }

    // Format HTML output
    return diffs.map(d => {
      let word = escapeHtml(d.text);
      // Format markdown bold **...**
      word = word.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

      if (d.type === 'delete') {
        return `<del class="diff-del">${word}</del>`;
      } else if (d.type === 'insert') {
        return `<ins class="diff-ins">${word}</ins>`;
      } else {
        return `<span>${word}</span>`;
      }
    }).join(' ');
  }

  // -------------------------------------------------------------
  // Data Fetching & State
  // -------------------------------------------------------------
  function getMasterHeaders() {
    return {
      'X-Master-Email': (window.AuthGate && typeof window.AuthGate.getReviewerEmail === 'function' ? window.AuthGate.getReviewerEmail() : 'rhabbaz@gmail.com'),
      'X-Master-Code': (window.AuthGate && typeof window.AuthGate.getMasterCode === 'function' ? window.AuthGate.getMasterCode() : '')
    };
  }

  function extractFlaggedWords(text) {
    if (!text) return [];
    const matches = [];
    const re = /\?\?(.+?)\?\?/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      matches.push(m[1]);
    }
    return matches;
  }

  async function fetchSummary() {
    try {
      const resp = await fetch('/api/editorial/summary', {
        headers: getMasterHeaders()
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.status === 'ok') {
        summaryData = data;
        renderAll();
        return;
      }
      throw new Error('API returned status ' + data.status);
    } catch (err) {
      console.warn('API /api/editorial/summary unavailable, falling back to Firebase RTDB:', err);
    }

    // Static hosting (GitHub Pages) or backend offline: aggregate review state straight from RTDB.
    try {
      await fetchSummaryFromRtdb();
    } catch (fallbackErr) {
      console.error('Failed to load editorial summary from RTDB fallback:', fallbackErr);
      const qContainer = document.getElementById('questionsContainer');
      if (qContainer) {
        qContainer.innerHTML = `<div class="empty-state">Error loading editorial summary. Please refresh.</div>`;
      }
    }
  }

  async function fetchSummaryFromRtdb() {
    const dbUrl = getDbBaseUrl();
    // The rules require a signed-in approved reviewer to read /reviews.
    const token = (window.AuthGate && typeof window.AuthGate.ensureAuthToken === 'function')
      ? await window.AuthGate.ensureAuthToken()
      : '';
    const authParam = token ? `?auth=${encodeURIComponent(token)}` : '';

    const resp = await fetch(`${dbUrl}/reviews.json${authParam}`);
    if (!resp.ok) throw new Error(`RTDB fetch failed HTTP ${resp.status}`);
    const reviews = await resp.json() || {};

    // Baseline text for every page that has edits, loaded in parallel
    const pageIds = Object.keys(reviews).filter(pid => /^page-\d{2}$/.test(pid) && reviews[pid] && reviews[pid].lines);
    const baseByPage = {};
    await Promise.all(pageIds.map(async pid => {
      const baseMap = {};
      try {
        const br = await fetch(`review_data/${pid}.json`);
        if (br.ok) {
          const bd = await br.json();
          (bd.lines || []).forEach((l, bi) => { baseMap[l.line_id] = { text: l.text || '', idx: bi, kind: l.kind || 'main' }; });
        }
      } catch (e) { /* baseline unavailable: diffs skipped for this page */ }
      baseByPage[pid] = baseMap;
    }));

    let totalDiffs = 0;
    let totalCompleted = 0;
    let totalMerged = 0;
    const flaggedQuestions = [];
    const submittedPages = [];

    for (let i = 1; i <= 89; i++) {
      const pid = `page-${String(i).padStart(2, '0')}`;
      const rev = reviews[pid] || {};
      const meta = rev.meta || {};
      const status = meta.status || 'available';
      const claimant = meta.claimed_by || '';

      if (status === 'completed') totalCompleted++;
      if (status === 'merged') totalMerged++;

      const lineEntries = Object.entries(rev.lines || {}).filter(([lid]) => isSafeKey(lid));
      const baseMap = baseByPage[pid] || {};
      let pageDiffCnt = 0;
      let pageFlaggedCnt = 0;
      let pageVerifiedCnt = 0;
      const diffs = [];

      lineEntries.forEach(([lid, linfo], idx) => {
        const base = baseMap[lid] || null;
        const text = linfo.text || '';
        const isVerified = !!linfo.verified;
        const flaggedWords = extractFlaggedWords(text);
        const isFlagged = !!linfo.flagged || flaggedWords.length > 0;

        if (isVerified) pageVerifiedCnt++;
        if (isFlagged) {
          pageFlaggedCnt++;
          flaggedQuestions.push({
            page_id: pid,
            page_num: i,
            line_id: lid,
            line_idx: base ? base.idx : idx,
            kind: base ? base.kind : 'main',
            original_text: base ? base.text : text,
            current_text: text,
            flagged_words: flaggedWords,
            reviewer: linfo.edited_by || claimant || 'Unknown',
            updated_at: linfo.updated_at || meta.last_activity || 0,
            verified: isVerified
          });
        }

        if (base && text && text !== base.text) {
          diffs.push({
            line_id: lid,
            line_idx: base.idx,
            kind: base.kind,
            original_text: base.text,
            reviewer_text: text,
            verified: isVerified,
            flagged: isFlagged
          });
          pageDiffCnt++;
        }
      });

      if (diffs.length > 0 || status === 'completed' || status === 'merged' || claimant) {
        totalDiffs += pageDiffCnt;
        submittedPages.push({
          page_id: pid,
          page_num: i,
          status,
          claimed_by: claimant,
          last_activity: meta.last_activity || 0,
          flagged_count: pageFlaggedCnt,
          verified_count: pageVerifiedCnt,
          diff_count: pageDiffCnt,
          diffs
        });
      }
    }

    summaryData = {
      status: 'ok',
      source: 'rtdb',
      stats: {
        total_flagged_questions: flaggedQuestions.length,
        total_pending_diffs: totalDiffs,
        total_submitted_pages: submittedPages.length,
        total_completed_pages: totalCompleted,
        total_merged_pages: totalMerged
      },
      flagged_questions: flaggedQuestions,
      submitted_pages: submittedPages
    };
    renderAll();
  }

  function renderAll() {
    updateHeroStats();
    renderQuestions();
    renderSubmissions();
  }

  function updateHeroStats() {
    const stats = summaryData.stats || {};
    const qCount = summaryData.flagged_questions ? summaryData.flagged_questions.length : (stats.total_flagged_questions || 0);
    const diffCount = stats.total_pending_diffs || 0;
    const compCount = stats.total_completed_pages || 0;
    const mergeCount = stats.total_merged_pages || 0;

    const elQ = document.getElementById('statFlaggedQuestions');
    if (elQ) elQ.textContent = qCount;
    const elD = document.getElementById('statPendingDiffs');
    if (elD) elD.textContent = diffCount;
    const elC = document.getElementById('statCompletedPages');
    if (elC) elC.textContent = compCount;
    const elM = document.getElementById('statMergedPages');
    if (elM) elM.textContent = mergeCount;

    const tabQ = document.getElementById('tabCountQuestions');
    if (tabQ) tabQ.textContent = qCount;
    const tabS = document.getElementById('tabCountSubmissions');
    if (tabS) tabS.textContent = summaryData.submitted_pages ? summaryData.submitted_pages.length : 0;
  }

  // -------------------------------------------------------------
  // Tab 1: Flagged Open Questions
  // -------------------------------------------------------------
  function renderQuestions() {
    const container = document.getElementById('questionsContainer');
    if (!container) return;

    let list = summaryData.flagged_questions || [];

    // Filter by kind
    if (filterKind !== 'all') {
      list = list.filter(q => q.kind === filterKind);
    }

    // Filter by search
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      list = list.filter(q => 
        q.page_id.toLowerCase().includes(term) ||
        (q.reviewer && q.reviewer.toLowerCase().includes(term)) ||
        (q.current_text && q.current_text.includes(term)) ||
        (q.flagged_words && q.flagged_words.some(w => w.includes(term)))
      );
    }

    if (list.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          🎉 No open questions found matching your filter criteria.
        </div>
      `;
      return;
    }

    container.innerHTML = '';

    list.forEach(q => {
      const card = document.createElement('article');
      card.className = 'question-card';
      card.id = `qcard-${escapeHtml(q.page_id)}-${escapeHtml(q.line_id)}`;

      const pillsHtml = (q.flagged_words || []).map(w => 
        `<span class="flagged-word-pill">🚩 ${escapeHtml(w)}</span>`
      ).join(' ');

      const defaultCleanValue = (q.current_text || '').replace(/\?\?(.+?)\?\?/g, '$1');

      card.innerHTML = `
        <div class="card-header-bar">
          <div class="card-tags">
            <span class="badge-page">Page ${escapeHtml(q.page_num)}</span>
            <span class="badge-line">Line ${Number(q.line_idx) + 1}</span>
            <span class="${q.kind === 'footnote' ? 'badge-kind-footnote' : 'badge-line'}">${q.kind === 'footnote' ? 'Footnote' : 'Main'}</span>
          </div>
          <div class="card-meta-text">
            Flagged by <strong>${escapeHtml(q.reviewer || 'Reviewer')}</strong>
          </div>
        </div>

        <div class="crop-preview-wrap">
          <img class="question-crop-img" 
               src="/api/line_crop/${seg(q.page_id)}/${seg(q.line_id)}" 
               alt="Scan crop for ${escapeHtml(q.page_id)} line ${Number(q.line_idx) + 1}" 
               loading="lazy"
               onerror="this.parentElement.style.display='none'">
        </div>

        <div class="card-body-content">
          <div class="question-context-box">
            <div class="question-context-label">Full Line Context (with doubtful reading highlighted):</div>
            <div class="question-full-sentence" dir="rtl">${formatContextSentence(q.current_text)}</div>
          </div>

          <div class="flagged-pills-row">
            <span class="flagged-pills-label">Flagged Doubtful Readings:</span>
            ${pillsHtml}
          </div>

          <div class="resolution-row">
            <input type="text" 
                   class="question-resolve-input" 
                   placeholder="Enter resolved Hebrew reading..." 
                   aria-label="Resolved Hebrew text">
            <div class="resolution-actions">
              <button class="btn-resolve-question" data-page="${escapeHtml(q.page_id)}" data-line="${escapeHtml(q.line_id)}">
                ✓ Resolve & Verify
              </button>
              <a href="review?page=${seg(q.page_id)}&line=${seg(q.line_id)}" class="btn-open-in-review" target="_blank">
                🔍 Open in Editor
              </a>
            </div>
          </div>
        </div>
      `;

      // Set input value cleanly via DOM property to prevent any quote truncation
      const inputEl = card.querySelector('.question-resolve-input');
      if (inputEl) {
        inputEl.value = defaultCleanValue;
      }

      // Attach resolve event handler
      const resolveBtn = card.querySelector('.btn-resolve-question');

      resolveBtn.addEventListener('click', async () => {
        const resolvedText = inputEl.value.trim();
        if (!resolvedText) return;

        resolveBtn.disabled = true;
        resolveBtn.textContent = 'Saving...';

        try {
          const resp = await fetch('/api/editorial/resolve_flag', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...getMasterHeaders()
            },
            body: JSON.stringify({
              page_id: q.page_id,
              line_id: q.line_id,
              resolved_text: resolvedText,
              resolver: 'ChiefEditor'
            })
          });

          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const res = await resp.json();

          if (res.status === 'ok') {
            card.classList.add('resolved');
            resolveBtn.textContent = '✓ Resolved';
            // Live cross-tab sync!
            await fetchSummary();
          } else {
            alert('Failed to resolve flag: ' + (res.message || 'Unknown error'));
            resolveBtn.disabled = false;
            resolveBtn.textContent = '✓ Resolve & Verify';
          }
        } catch (err) {
          console.error('Error resolving flag:', err);
          alert('Network error resolving flag.');
          resolveBtn.disabled = false;
          resolveBtn.textContent = '✓ Resolve & Verify';
        }
      });

      container.appendChild(card);
    });
  }

  // -------------------------------------------------------------
  // Tab 2: Submitted Folio Edits & Diffs
  // -------------------------------------------------------------
  function renderSubmissions() {
    const container = document.getElementById('submissionsContainer');
    if (!container) return;

    let list = summaryData.submitted_pages || [];

    // Filter by search
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      list = list.filter(p => 
        p.page_id.toLowerCase().includes(term) ||
        (p.claimed_by && p.claimed_by.toLowerCase().includes(term))
      );
    }

    if (list.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          No submitted folio edits found matching your filter criteria.
        </div>
      `;
      return;
    }

    container.innerHTML = '';

    list.forEach(p => {
      const card = document.createElement('article');
      card.className = 'submission-page-card';
      card.id = `subcard-${escapeHtml(p.page_id)}`;

      // Build diffs rows HTML
      const diffRowsHtml = (p.diffs || []).map(d => `
        <div class="diff-row" id="diff-row-${escapeHtml(p.page_id)}-${escapeHtml(d.line_id)}">
          <div class="diff-row-header">
            <div class="diff-row-meta">
              <span class="badge-line">Line ${Number(d.line_idx) + 1}</span>
              <span class="${d.kind === 'footnote' ? 'badge-kind-footnote' : 'badge-line'}">${d.kind === 'footnote' ? 'Footnote' : 'Main'}</span>
              ${d.verified ? '<span class="status-badge status-completed">✓ Verified</span>' : '<span class="status-badge">Unverified</span>'}
              ${d.flagged ? '<span class="status-badge" style="color:var(--accent-red);border-color:var(--accent-red);">🚩 Flagged</span>' : ''}
            </div>
            <div class="diff-row-actions">
              <button class="btn-diff-action btn-toggle-diff-crop" data-page="${escapeHtml(p.page_id)}" data-line="${escapeHtml(d.line_id)}">🖼️ Scan Crop</button>
              <a href="review?page=${seg(p.page_id)}&line=${seg(d.line_id)}" class="btn-diff-action btn-open-diff-line" target="_blank">🔍 Open Line</a>
              <button class="btn-diff-action btn-reject-line" data-page="${escapeHtml(p.page_id)}" data-line="${escapeHtml(d.line_id)}">✕ Reject Edit</button>
            </div>
          </div>
          <div class="diff-body">
            ${computeWordDiff(d.original_text, d.reviewer_text)}
          </div>
          <div class="diff-crop-drawer" id="diff-crop-${escapeHtml(p.page_id)}-${escapeHtml(d.line_id)}" style="display:none;"></div>
        </div>
      `).join('');

      const hasOpenFlags = p.flagged_count > 0;
      const isMerged = p.status === 'merged';

      card.innerHTML = `
        <div class="sub-header-bar">
          <div class="sub-left">
            <span class="sub-title">Page ${escapeHtml(p.page_num)} (${escapeHtml(p.page_id)})</span>
            <span class="sub-status-badge status-${escapeHtml(p.status)}">${escapeHtml(String(p.status).replace('_', ' '))}</span>
            <span class="card-meta-text">Claimant: <strong>${escapeHtml(p.claimed_by || 'Unclaimed')}</strong></span>
          </div>
          <div class="card-tags">
            <span class="badge-line">${escapeHtml(p.diff_count)} text modification(s)</span>
            ${hasOpenFlags ? `<span class="badge-kind-footnote" style="background:rgba(239,68,68,0.2);color:#ef4444;border-color:rgba(239,68,68,0.4);">🚩 ${escapeHtml(p.flagged_count)} Open Question(s)</span>` : ''}
          </div>
        </div>

        <div class="diff-list">
          ${diffRowsHtml || '<div class="empty-state" style="padding:16px;">No text differences with baseline.</div>'}
        </div>

        <div class="sub-footer-bar">
          <div class="sub-footer-left">
            ${hasOpenFlags ? `
              <span class="merge-warning" title="Open questions must be resolved before merging to canonical state">
                ⚠️ ${escapeHtml(p.flagged_count)} open question(s) must be resolved before merging
              </span>
            ` : isMerged ? `
              <span style="color:var(--accent-blue);font-size:12px;font-weight:600;">
                ✓ Already merged into canonical edition
              </span>
            ` : `
              <span style="color:var(--text-muted);font-size:12px;">
                Ready for canonical promotion.
              </span>
            `}
          </div>

          <div class="sub-footer-actions">
            <button class="btn-reject-page" data-page="${escapeHtml(p.page_id)}" ${isMerged ? 'disabled' : ''}>
              ✕ Reject All Edits
            </button>
            <button class="btn-merge-page" 
                    data-page="${escapeHtml(p.page_id)}" 
                    ${hasOpenFlags || isMerged ? 'disabled' : ''}>
              ${isMerged ? 'Merged ✓' : '🚀 Approve & Merge to Canonical'}
            </button>
          </div>
        </div>
      `;

      // Wire Diff Scan Crop toggles
      card.querySelectorAll('.btn-toggle-diff-crop').forEach(btn => {
        btn.addEventListener('click', () => {
          const pageId = btn.getAttribute('data-page');
          const lineId = btn.getAttribute('data-line');
          const drawer = card.querySelector(`#diff-crop-${pageId}-${lineId}`);
          if (!drawer) return;
          if (drawer.style.display === 'none' || !drawer.style.display) {
            drawer.style.display = 'block';
            if (!drawer.querySelector('.diff-crop-img')) {
              drawer.innerHTML = `<img class="diff-crop-img" src="/api/line_crop/${seg(pageId)}/${seg(lineId)}" alt="Line scan crop" loading="lazy">`;
            }
            btn.textContent = 'Hide Crop';
          } else {
            drawer.style.display = 'none';
            btn.textContent = '🖼️ Scan Crop';
          }
        });
      });

      // Wire Reject Line buttons
      card.querySelectorAll('.btn-reject-line').forEach(btn => {
        btn.addEventListener('click', async () => {
          const pageId = btn.getAttribute('data-page');
          const lineId = btn.getAttribute('data-line');
          if (!confirm(`Are you sure you want to reject this edit and revert line to baseline?`)) {
            return;
          }
          btn.disabled = true;
          btn.textContent = 'Rejecting...';
          try {
            const resp = await fetch('/api/editorial/reject_line', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...getMasterHeaders()
              },
              body: JSON.stringify({ page_id: pageId, line_id: lineId, rejector: 'ChiefEditor' })
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const res = await resp.json();
            if (res.status === 'ok') {
              await fetchSummary();
            } else {
              alert('Failed to reject edit: ' + (res.message || 'Unknown error'));
              btn.disabled = false;
              btn.textContent = '✕ Reject Edit';
            }
          } catch (err) {
            console.error('Error rejecting line:', err);
            alert('Network error rejecting line edit.');
            btn.disabled = false;
            btn.textContent = '✕ Reject Edit';
          }
        });
      });

      // Wire Reject Page button
      const rejectPageBtn = card.querySelector('.btn-reject-page');
      if (rejectPageBtn && !rejectPageBtn.disabled) {
        rejectPageBtn.addEventListener('click', async () => {
          if (!confirm(`Are you sure you want to reject ALL edits on ${escapeHtml(p.page_id)}?`)) {
            return;
          }
          rejectPageBtn.disabled = true;
          rejectPageBtn.textContent = 'Rejecting...';
          try {
            const resp = await fetch('/api/editorial/reject_page', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...getMasterHeaders()
              },
              body: JSON.stringify({ page_id: p.page_id, rejector: 'ChiefEditor' })
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const res = await resp.json();
            if (res.status === 'ok') {
              await fetchSummary();
            } else {
              alert('Failed to reject page edits: ' + (res.message || 'Unknown error'));
              rejectPageBtn.disabled = false;
              rejectPageBtn.textContent = '✕ Reject All Edits';
            }
          } catch (err) {
            console.error('Error rejecting page:', err);
            alert('Network error rejecting page edits.');
            rejectPageBtn.disabled = false;
            rejectPageBtn.textContent = '✕ Reject All Edits';
          }
        });
      }

      // Merge button event handler
      const mergeBtn = card.querySelector('.btn-merge-page');
      if (mergeBtn && !mergeBtn.disabled) {
        mergeBtn.addEventListener('click', async () => {
          if (!confirm(`Are you sure you want to approve and merge ${escapeHtml(p.page_id)} into canonical text_state?`)) {
            return;
          }

          mergeBtn.disabled = true;
          mergeBtn.textContent = 'Merging...';

          try {
            const resp = await fetch('/api/editorial/merge_page', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...getMasterHeaders()
              },
              body: JSON.stringify({
                page_id: p.page_id,
                approver: 'ChiefEditor'
              })
            });

            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const res = await resp.json();

            if (res.status === 'ok') {
              mergeBtn.textContent = 'Merged ✓';
              const statusBadge = card.querySelector('.sub-status-badge');
              if (statusBadge) {
                statusBadge.className = 'sub-status-badge status-merged';
                statusBadge.textContent = 'MERGED';
              }
              // Increment merged stats
              const statM = document.getElementById('statMergedPages');
              if (statM) {
                const curM = parseInt(statM.textContent, 10) || 0;
                statM.textContent = curM + 1;
              }
              p.status = 'merged';
            } else {
              alert('Failed to merge: ' + (res.message || 'Unknown error'));
              mergeBtn.disabled = false;
              mergeBtn.textContent = '🚀 Approve & Merge to Canonical';
            }
          } catch (err) {
            console.error('Error merging page:', err);
            alert('Network error merging page.');
            mergeBtn.disabled = false;
            mergeBtn.textContent = '🚀 Approve & Merge to Canonical';
          }
        });
      }

      container.appendChild(card);
    });
  }

  // -------------------------------------------------------------
  // Tab 3: Approved Reviewers & Access Requests (Chief Editor)
  // -------------------------------------------------------------
  let accessControlData = {
    requests: {},
    approved: {},
    preapproved: {}
  };

  function getDbBaseUrl() {
    return (typeof window !== 'undefined' && window.FIREBASE_DB_URL)
      ? window.FIREBASE_DB_URL
      : (typeof window !== 'undefined' && window.location && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'))
        ? window.location.origin
        : 'https://iyye-hayyam-default-rtdb.firebaseio.com';
  }

  async function loadAccessControlData() {
    const isMaster = window.AuthGate && typeof window.AuthGate.isMasterEditor === 'function' && window.AuthGate.isMasterEditor();
    const notice = document.getElementById('accessRestrictedNotice');
    const content = document.getElementById('accessControlContent');

    if (!isMaster) {
      if (notice) notice.style.display = 'block';
      if (content) content.style.display = 'none';
      return;
    }

    if (notice) notice.style.display = 'none';
    if (content) content.style.display = 'block';

    const dbUrl = getDbBaseUrl();
    const token = (window.AuthGate && typeof window.AuthGate.ensureAuthToken === 'function')
      ? await window.AuthGate.ensureAuthToken()
      : '';
    const authParam = token ? `?auth=${encodeURIComponent(token)}` : '';

    try {
      const [reqRes, appRes, preRes] = await Promise.all([
        fetch(`${dbUrl}/access_requests.json${authParam}`).catch(() => null),
        fetch(`${dbUrl}/approved_reviewers.json${authParam}`).catch(() => null),
        fetch(`${dbUrl}/preapproved_emails.json${authParam}`).catch(() => null)
      ]);

      accessControlData.requests = (reqRes && reqRes.ok) ? (await reqRes.json() || {}) : {};
      accessControlData.approved = (appRes && appRes.ok) ? (await appRes.json() || {}) : {};
      accessControlData.preapproved = (preRes && preRes.ok) ? (await preRes.json() || {}) : {};

      renderAccessControl();
    } catch (err) {
      console.error('[Editorial] Error loading access control data:', err);
    }
  }

  function renderAccessControl() {
    renderPendingRequests();
    renderApprovedReviewers();
    renderPreapprovedEmails();
  }

  // Show waiting requests in the browser tab title, e.g. "(2) Master Editorial Hub"
  const BASE_DOCUMENT_TITLE = document.title.replace(/^\(\d+\)\s*/, '');
  function updateDocumentTitleBadge(count) {
    document.title = count > 0 ? `(${count}) ${BASE_DOCUMENT_TITLE}` : BASE_DOCUMENT_TITLE;
  }

  function renderPendingRequests() {
    const container = document.getElementById('pendingRequestsContainer');
    const countEl = document.getElementById('countPendingRequests');
    const tabCountEl = document.getElementById('tabCountPendingRequests');
    if (!container) return;

    const allRequests = accessControlData.requests || {};
    const pendingList = Object.entries(allRequests)
      .map(([uid, data]) => ({ ...data, uid }))
      .filter(item => item && item.status === 'pending');

    if (countEl) countEl.textContent = pendingList.length;
    if (tabCountEl) tabCountEl.textContent = pendingList.length;
    if (tabCountEl) tabCountEl.classList.toggle('has-pending', pendingList.length > 0);
    updateDocumentTitleBadge(pendingList.length);

    if (pendingList.length === 0) {
      container.innerHTML = `<div class="empty-state">No pending access requests. All incoming Google users are approved or handled.</div>`;
      return;
    }

    // Check pre-approved whitelist emails
    const preapprovedList = Object.values(accessControlData.preapproved || {}).map(item => (item.email || '').toLowerCase());

    container.innerHTML = '';
    pendingList.forEach(req => {
      const card = document.createElement('div');
      card.className = 'access-item-card';

      const email = (req.email || '').toLowerCase();
      const isPreapproved = preapprovedList.includes(email);
      const knowsPhrase = req.phrase_hash === ACCESS_PHRASE_HASH;
      const name = req.displayName || email.split('@')[0];
      const photo = req.photoURL || '';
      const dateStr = req.requested_at ? new Date(req.requested_at).toLocaleString() : 'Recently';

      card.innerHTML = `
        <div class="access-item-left">
          <div class="access-avatar">
            ${photo ? `<img src="${escapeHtml(photo)}" alt="Avatar">` : name.charAt(0).toUpperCase()}
          </div>
          <div class="access-meta">
            <div class="access-name">
              <span>${escapeHtml(name)}</span>
              ${isPreapproved ? '<span class="access-badge badge-preapproved">⭐ Whitelisted / Pre-Approved</span>' : '<span class="access-badge badge-pending">Pending Review</span>'}
              ${knowsPhrase ? '<span class="access-badge badge-preapproved">🎩 Knows the phrase</span>' : ''}
            </div>
            <div class="access-email">${escapeHtml(email)} • <code style="font-size: 11px;">${escapeHtml(req.uid)}</code></div>
            <div class="access-date">Requested: ${escapeHtml(dateStr)}</div>
          </div>
        </div>
        <div class="access-actions">
          <button class="btn-action-approve" data-uid="${escapeHtml(req.uid)}" data-email="${escapeHtml(email)}" data-name="${escapeHtml(name)}">
            ✅ Approve Reviewer
          </button>
          <button class="btn-action-reject" data-uid="${escapeHtml(req.uid)}">
            ❌ Reject
          </button>
        </div>
      `;

      const btnApprove = card.querySelector('.btn-action-approve');
      btnApprove.addEventListener('click', async () => {
        btnApprove.disabled = true;
        btnApprove.textContent = 'Approving...';
        await approveReviewer(req.uid, email, name);
      });

      const btnReject = card.querySelector('.btn-action-reject');
      btnReject.addEventListener('click', async () => {
        btnReject.disabled = true;
        btnReject.textContent = 'Rejecting...';
        await rejectReviewer(req.uid);
      });

      container.appendChild(card);
    });
  }

  function renderApprovedReviewers() {
    const container = document.getElementById('approvedReviewersContainer');
    const countEl = document.getElementById('countApprovedReviewers');
    if (!container) return;

    const allApproved = accessControlData.approved || {};
    const approvedList = Object.entries(allApproved).map(([uid, val]) => {
      if (val === true) {
        // Fallback to request profile if available
        const req = accessControlData.requests && accessControlData.requests[uid];
        return {
          uid,
          email: req ? req.email : uid,
          displayName: req ? req.displayName : uid,
          approved_at: req ? req.requested_at : null
        };
      }
      return { ...val, uid };
    });

    if (countEl) countEl.textContent = approvedList.length;

    if (approvedList.length === 0) {
      container.innerHTML = `<div class="empty-state">No approved reviewers yet. When scholars request access with Google, approve them above.</div>`;
      return;
    }

    container.innerHTML = '';
    approvedList.forEach(rev => {
      const card = document.createElement('div');
      card.className = 'access-item-card';

      const email = rev.email || rev.uid;
      const name = rev.displayName || email.split('@')[0];
      const dateStr = rev.approved_at ? new Date(rev.approved_at).toLocaleString() : 'Approved';

      card.innerHTML = `
        <div class="access-item-left">
          <div class="access-avatar" style="background: #059669;">
            ${escapeHtml(name.charAt(0).toUpperCase())}
          </div>
          <div class="access-meta">
            <div class="access-name">
              <span>${escapeHtml(name)}</span>
              <span class="access-badge badge-approved">Active Reviewer</span>
            </div>
            <div class="access-email">${escapeHtml(email)} • <code style="font-size: 11px;">${escapeHtml(rev.uid)}</code></div>
            <div class="access-date">Granted: ${escapeHtml(dateStr)}</div>
          </div>
        </div>
        <div class="access-actions">
          <button class="btn-action-revoke" data-uid="${escapeHtml(rev.uid)}" data-email="${escapeHtml(email)}">
            🚫 Revoke Access
          </button>
        </div>
      `;

      const btnRevoke = card.querySelector('.btn-action-revoke');
      btnRevoke.addEventListener('click', async () => {
        if (confirm(`Revoke reviewer access for ${email}? They will no longer be able to read or edit folios.`)) {
          btnRevoke.disabled = true;
          btnRevoke.textContent = 'Revoking...';
          await revokeReviewer(rev.uid, email);
        }
      });

      container.appendChild(card);
    });
  }

  function renderPreapprovedEmails() {
    const container = document.getElementById('preapprovedEmailsContainer');
    const countEl = document.getElementById('countPreapprovedEmails');
    if (!container) return;

    const allPre = accessControlData.preapproved || {};
    const preList = Object.entries(allPre).map(([key, data]) => ({ ...data, key }));

    if (countEl) countEl.textContent = preList.length;

    if (preList.length === 0) {
      container.innerHTML = `<div class="empty-state">No pre-approved emails whitelist yet. Use the form above to pre-approve academic colleagues before they log in.</div>`;
      return;
    }

    container.innerHTML = '';
    preList.forEach(item => {
      const card = document.createElement('div');
      card.className = 'access-item-card';

      const dateStr = item.added_at ? new Date(item.added_at).toLocaleString() : 'Added';

      card.innerHTML = `
        <div class="access-item-left">
          <div class="access-avatar" style="background: #7c3aed;">
            ✉️
          </div>
          <div class="access-meta">
            <div class="access-name">
              <span>${escapeHtml(item.email)}</span>
              <span class="access-badge badge-preapproved">Pre-Approved</span>
            </div>
            <div class="access-email">${escapeHtml(item.note || 'No affiliation note')}</div>
            <div class="access-date">Added: ${escapeHtml(dateStr)}</div>
          </div>
        </div>
        <div class="access-actions">
          <button class="btn-action-reject" data-key="${escapeHtml(item.key)}">
            🗑️ Remove
          </button>
        </div>
      `;

      const btnRemove = card.querySelector('.btn-action-reject');
      btnRemove.addEventListener('click', async () => {
        btnRemove.disabled = true;
        await removePreapprovedEmail(item.key);
      });

      container.appendChild(card);
    });
  }

  const ACCESS_PHRASE_HASH = 'b849db1dfa3ddaaba6da17bdc618bf5beb0ebd65272be51b18f38c83e69b0a25';

  async function approveReviewer(uid, email, displayName) {
    const dbUrl = getDbBaseUrl();
    const token = (window.AuthGate && typeof window.AuthGate.ensureAuthToken === 'function')
      ? await window.AuthGate.ensureAuthToken()
      : '';
    const authParam = token ? `?auth=${encodeURIComponent(token)}` : '';

    const payload = {
      approved: true,
      email: email,
      displayName: displayName,
      approved_at: new Date().toISOString()
    };

    try {
      // 1. Write to approved_reviewers/$uid
      await fetch(`${dbUrl}/approved_reviewers/${encodeURIComponent(uid)}.json${authParam}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      // 2. Update access_requests/$uid/status
      await fetch(`${dbUrl}/access_requests/${encodeURIComponent(uid)}/status.json${authParam}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify('approved')
      });

      await loadAccessControlData();
    } catch (err) {
      console.error('[Editorial] Approve reviewer failed:', err);
      alert('Failed to approve reviewer: ' + (err.message || err));
    }
  }

  async function rejectReviewer(uid) {
    const dbUrl = getDbBaseUrl();
    const token = (window.AuthGate && typeof window.AuthGate.ensureAuthToken === 'function')
      ? await window.AuthGate.ensureAuthToken()
      : '';
    const authParam = token ? `?auth=${encodeURIComponent(token)}` : '';

    try {
      await fetch(`${dbUrl}/access_requests/${encodeURIComponent(uid)}/status.json${authParam}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify('rejected')
      });

      await loadAccessControlData();
    } catch (err) {
      console.error('[Editorial] Reject reviewer failed:', err);
      alert('Failed to reject request: ' + (err.message || err));
    }
  }

  async function revokeReviewer(uid, email) {
    const dbUrl = getDbBaseUrl();
    const token = (window.AuthGate && typeof window.AuthGate.ensureAuthToken === 'function')
      ? await window.AuthGate.ensureAuthToken()
      : '';
    const authParam = token ? `?auth=${encodeURIComponent(token)}` : '';

    try {
      // 1. Remove from approved_reviewers/$uid
      await fetch(`${dbUrl}/approved_reviewers/${encodeURIComponent(uid)}.json${authParam}`, {
        method: 'DELETE'
      });

      // 2. Mark access_requests/$uid status as revoked
      await fetch(`${dbUrl}/access_requests/${encodeURIComponent(uid)}/status.json${authParam}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify('revoked')
      });

      await loadAccessControlData();
    } catch (err) {
      console.error('[Editorial] Revoke reviewer failed:', err);
      alert('Failed to revoke reviewer: ' + (err.message || err));
    }
  }

  async function submitPreapprove(email, note) {
    const dbUrl = getDbBaseUrl();
    const token = (window.AuthGate && typeof window.AuthGate.ensureAuthToken === 'function')
      ? await window.AuthGate.ensureAuthToken()
      : '';
    const authParam = token ? `?auth=${encodeURIComponent(token)}` : '';
    const cleanEmail = (email || '').trim().toLowerCase();
    const key = 'pre_' + cleanEmail.replace(/[^a-zA-Z0-9]/g, '_');

    const payload = {
      email: cleanEmail,
      note: (note || '').trim(),
      added_at: new Date().toISOString()
    };

    try {
      await fetch(`${dbUrl}/preapproved_emails/${encodeURIComponent(key)}.json${authParam}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      await loadAccessControlData();
      return { success: true };
    } catch (err) {
      console.error('[Editorial] Pre-approve failed:', err);
      return { success: false, error: err.message || err };
    }
  }

  async function removePreapprovedEmail(key) {
    const dbUrl = getDbBaseUrl();
    const token = (window.AuthGate && typeof window.AuthGate.ensureAuthToken === 'function')
      ? await window.AuthGate.ensureAuthToken()
      : '';
    const authParam = token ? `?auth=${encodeURIComponent(token)}` : '';

    try {
      await fetch(`${dbUrl}/preapproved_emails/${encodeURIComponent(key)}.json${authParam}`, {
        method: 'DELETE'
      });
      await loadAccessControlData();
    } catch (err) {
      console.error('[Editorial] Remove pre-approved email failed:', err);
    }
  }

  // -------------------------------------------------------------
  // Toolbar, Tabs & Filter Handlers
  // -------------------------------------------------------------
  function initHandlers() {
    const tabQuestions = document.getElementById('tabBtnQuestions');
    const tabSubmissions = document.getElementById('tabBtnSubmissions');
    const tabAccess = document.getElementById('tabBtnAccessControl');
    const viewQuestions = document.getElementById('questionsView');
    const viewSubmissions = document.getElementById('submissionsView');
    const viewAccess = document.getElementById('accessControlView');

    if (tabQuestions && tabSubmissions) {
      tabQuestions.addEventListener('click', () => {
        activeTab = 'questions';
        tabQuestions.classList.add('active');
        tabSubmissions.classList.remove('active');
        if (tabAccess) tabAccess.classList.remove('active');
        viewQuestions.classList.add('active');
        viewSubmissions.classList.remove('active');
        if (viewAccess) viewAccess.classList.remove('active');
      });

      tabSubmissions.addEventListener('click', () => {
        activeTab = 'submissions';
        tabSubmissions.classList.add('active');
        tabQuestions.classList.remove('active');
        if (tabAccess) tabAccess.classList.remove('active');
        viewSubmissions.classList.add('active');
        viewQuestions.classList.remove('active');
        if (viewAccess) viewAccess.classList.remove('active');
      });
    }

    if (tabAccess && viewAccess) {
      tabAccess.addEventListener('click', () => {
        activeTab = 'access_control';
        tabAccess.classList.add('active');
        if (tabQuestions) tabQuestions.classList.remove('active');
        if (tabSubmissions) tabSubmissions.classList.remove('active');
        viewAccess.classList.add('active');
        if (viewQuestions) viewQuestions.classList.remove('active');
        if (viewSubmissions) viewSubmissions.classList.remove('active');
        loadAccessControlData();
      });
    }

    const btnRefreshAccess = document.getElementById('btnRefreshAccessRequests');
    if (btnRefreshAccess) {
      btnRefreshAccess.addEventListener('click', () => {
        btnRefreshAccess.textContent = 'Refreshing...';
        loadAccessControlData().finally(() => {
          btnRefreshAccess.textContent = '🔄 Refresh';
        });
      });
    }

    const formPre = document.getElementById('formPreapprove');
    if (formPre) {
      formPre.addEventListener('submit', async (e) => {
        e.preventDefault();
        const inputEmail = document.getElementById('inputPreapproveEmail');
        const inputNote = document.getElementById('inputPreapproveNote');
        const statusMsg = document.getElementById('preapproveStatusMsg');
        const btnSubmit = document.getElementById('btnSubmitPreapprove');

        if (!inputEmail || !inputEmail.value.trim()) return;

        btnSubmit.disabled = true;
        btnSubmit.textContent = 'Pre-Approving...';
        const res = await submitPreapprove(inputEmail.value, inputNote ? inputNote.value : '');

        btnSubmit.disabled = false;
        btnSubmit.textContent = 'Pre-Approve Email';

        if (res.success) {
          if (statusMsg) {
            statusMsg.style.display = 'block';
            statusMsg.style.color = '#10b981';
            statusMsg.textContent = `✓ Successfully pre-approved ${inputEmail.value.trim()}.`;
            setTimeout(() => { statusMsg.style.display = 'none'; }, 4000);
          }
          inputEmail.value = '';
          if (inputNote) inputNote.value = '';
        } else {
          if (statusMsg) {
            statusMsg.style.display = 'block';
            statusMsg.style.color = '#ef4444';
            statusMsg.textContent = `Failed to pre-approve: ${res.error}`;
          }
        }
      });
    }

    const searchInput = document.getElementById('editorialSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchTerm = e.target.value.trim();
        if (activeTab === 'questions') renderQuestions();
        else if (activeTab === 'submissions') renderSubmissions();
      });
    }

    const filterSelect = document.getElementById('editorialFilterSelect');
    if (filterSelect) {
      filterSelect.addEventListener('change', (e) => {
        filterKind = e.target.value;
        if (activeTab === 'questions') renderQuestions();
        else if (activeTab === 'submissions') renderSubmissions();
      });
    }

    const refreshBtn = document.getElementById('btnRefreshEditorial');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        refreshBtn.textContent = 'Refreshing...';
        fetchSummary().finally(() => {
          refreshBtn.textContent = '🔄 Refresh';
        });
      });
    }

    const exportBtn = document.getElementById('btnExportEdits');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        if (window.ReviewSync && typeof window.ReviewSync.exportEditsCsv === 'function') {
          window.ReviewSync.exportEditsCsv();
        }
      });
    }
  }

  // -------------------------------------------------------------
  // Initialization & Master Editor Gate Check
  // -------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    if (window.AuthGate && typeof window.AuthGate.verifyMasterPassword === 'function') {
      const ok = window.AuthGate.verifyMasterPassword('🔒 Chief Editor Access: Please enter the Master Editor Password to view the Master Hub:');
      if (!ok) {
        window.location.href = 'dashboard.html';
        return;
      }
    }
    initTheme();
    initHandlers();
    // Deep link from the new-reviewer approval email
    if (window.location.hash === '#access') {
      const tabAccessLink = document.getElementById('tabBtnAccessControl');
      if (tabAccessLink) tabAccessLink.click();
    }
    fetchSummary();
    // Load pending access requests up front so the tab badge is accurate without opening the tab
    loadAccessControlData();
  });
})();
