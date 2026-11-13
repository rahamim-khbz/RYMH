/**
 * review_sync.js
 * 
 * Handles Firebase Realtime Database persistence, Anonymous Auth,
 * soft claim locks, debounced line saving, history logging, and sync status.
 */

window.ReviewSync = (function() {
  const DB_BASE_URL = (typeof window !== 'undefined' && window.FIREBASE_DB_URL)
    ? window.FIREBASE_DB_URL
    : (typeof window !== 'undefined' && window.location && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'))
      ? window.location.origin
      : 'https://iyye-hayyam-default-rtdb.firebaseio.com';
  const LOCAL_STORAGE_PREFIX = 'ih_offline_review_';
  let reviewerName = localStorage.getItem('ih_reviewer_name') || '';
  let pendingSaves = new Map();
  let saveTimer = null;
  let hasUnsavedChanges = false;
  let pageReviewState = {};
  let pageSuggestions = {};

  // Extract query parameters - only accept ?reviewer= if AuthGate.isAuthorized() is true
  const urlParams = new URLSearchParams(window.location.search);
  const qReviewer = urlParams.get('reviewer');
  if (qReviewer && qReviewer.trim()) {
    if (window.AuthGate && typeof window.AuthGate.isAuthorized === 'function' && window.AuthGate.isAuthorized()) {
      reviewerName = qReviewer.trim();
      localStorage.setItem('ih_reviewer_name', reviewerName);
    }
  }

  function getReviewerName() {
    return reviewerName.trim() || 'Anonymous Reviewer';
  }

  function setReviewerName(name) {
    if (name && name.trim()) {
      reviewerName = name.trim();
      localStorage.setItem('ih_reviewer_name', reviewerName);
      updateReviewerBadge();
    }
  }

  function updateReviewerBadge() {
    const el = document.getElementById('reviewerNameDisplay');
    if (el) el.textContent = getReviewerName();
  }

  function updateSyncIndicator(state) {
    const dot = document.getElementById('syncDot');
    const text = document.getElementById('syncText');
    if (!dot || !text) return;

    dot.className = 'sync-dot';
    if (state === 'saving') {
      dot.classList.add('saving');
      text.textContent = 'Saving…';
    } else if (state === 'offline') {
      dot.classList.add('offline');
      text.textContent = 'Offline';
    } else {
      text.textContent = 'Saved';
    }
  }

  function getLocalReview(pageId) {
    try {
      const raw = localStorage.getItem(`${LOCAL_STORAGE_PREFIX}${pageId}`);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveLocalReview(pageId, data) {
    try {
      localStorage.setItem(`${LOCAL_STORAGE_PREFIX}${pageId}`, JSON.stringify(data));
    } catch (e) {
      console.warn('LocalStorage save error:', e);
    }
  }

  async function fetchJson(endpoint, options = {}) {
    try {
      let finalEndpoint = endpoint;
      if (window.AuthGate && typeof window.AuthGate.ensureAuthToken === 'function') {
        const token = await window.AuthGate.ensureAuthToken();
        if (token) {
          finalEndpoint += (finalEndpoint.indexOf('?') >= 0 ? '&auth=' : '?auth=') + encodeURIComponent(token);
        }
      }

      const res = await fetch(`${DB_BASE_URL}${finalEndpoint}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn(`Firebase REST sync note (${endpoint}):`, err.message);
      return null;
    }
  }

  async function initPage(pageId, localPageData) {
    updateReviewerBadge();
    updateSyncIndicator('saving');

    // 1. Check local storage first for instant offline/cached edits
    const localSaved = getLocalReview(pageId);
    if (localSaved) {
      pageReviewState[pageId] = localSaved;
      if (localSaved.lines && localPageData && localPageData.lines) {
        localPageData.lines.forEach((l, idx) => {
          if (localSaved.lines[l.line_id]) {
            const sLine = localSaved.lines[l.line_id];
            l.text = sLine.text;
            l.verified = !!sLine.verified;
            l.flagged = !!sLine.flagged || /\?\?(.+?)\?\?/.test(sLine.text || '');
            if (window.MacroView) {
              window.MacroView.updateLineContent(idx, sLine.text, !!sLine.verified);
            }
          }
        });
      }
    }

    // 2. Load existing reviews from Firebase RTDB (overrides if cloud has newer data)
    const remote = await fetchJson(`/reviews/${pageId}.json`);
    if (remote) {
      pageReviewState[pageId] = remote;
      saveLocalReview(pageId, remote);
      // Merge remote lines into local view if present
      if (remote.lines && localPageData && localPageData.lines) {
        localPageData.lines.forEach((l, idx) => {
          if (remote.lines[l.line_id]) {
            const rLine = remote.lines[l.line_id];
            l.text = rLine.text;
            l.verified = !!rLine.verified;
            l.flagged = !!rLine.flagged || /\?\?(.+?)\?\?/.test(rLine.text || '');
            if (window.MacroView) {
              window.MacroView.updateLineContent(idx, rLine.text, !!rLine.verified);
            } else if (rLine.verified) {
              const row = document.getElementById(`line-row-${idx}`);
              if (row) row.classList.add('verified');
            }
          }
        });
      }

      // Merge paragraph break overrides
      if (remote.paragraph_breaks && localPageData && localPageData.lines) {
        localPageData.lines.forEach(l => {
          const action = remote.paragraph_breaks[l.line_id];
          if (action === 'split') l.para_start = true;
          if (action === 'join') l.para_start = false;
        });
      }
    } else if (!localSaved) {
      pageReviewState[pageId] = { meta: { status: 'available' }, lines: {}, paragraph_breaks: {} };
    }

    // Load AI suggestions
    const suggestions = await fetchJson(`/redline_suggestions/${pageId}.json`);
    pageSuggestions[pageId] = suggestions || {};
    if (window.MacroView && window.MacroView.checkAiChips) {
      window.MacroView.checkAiChips();
    }

    updatePageStatusBadge(pageId);
    updateSyncIndicator('saved');

    // Start live sync listener / polling
    startLiveSync(pageId);
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const STALE_CLAIM_MS = 48 * 3600 * 1000;

  function isPageEditable(pageId) {
    const meta = (pageReviewState[pageId] && pageReviewState[pageId].meta) || {};
    const status = meta.status || 'available';
    const claimant = (meta.claimed_by || '').trim();
    const myName = getReviewerName().trim().toLowerCase();

    // Merged pages are permanently read-only
    if (status === 'merged') return false;

    // Available or unclaimed pages are editable (will auto-claim upon edit)
    if (status === 'available' || !claimant) return true;

    // If in_progress: editable only by the claimant
    if (status === 'in_progress') {
      if (claimant.toLowerCase() === myName) return true;
      const lastAct = meta.last_activity || 0;
      return (Date.now() - lastAct) > STALE_CLAIM_MS;
    }

    // If completed: editable if claimed by current user, or can be reopened
    if (status === 'completed') {
      return claimant.toLowerCase() === myName;
    }

    return false;
  }

  function getPageLockInfo(pageId) {
    const meta = (pageReviewState[pageId] && pageReviewState[pageId].meta) || {};
    const status = meta.status || 'available';
    const claimant = (meta.claimed_by || '').trim();
    const editable = isPageEditable(pageId);
    const lastAct = meta.last_activity || 0;
    const isStale = (Date.now() - lastAct) > (48 * 3600 * 1000);

    return {
      isEditable: editable,
      isLocked: !editable,
      status,
      claimant,
      isStale
    };
  }

  function updatePageStatusBadge(pageId) {
    const badge = document.getElementById('pageStatusBadge');
    const claimBtn = document.getElementById('btnClaimToggle');
    const completeBtn = document.getElementById('btnCompletePage');
    const lockBanner = document.getElementById('pageLockBanner');
    const lockBannerText = document.getElementById('pageLockBannerText');
    const bannerTakeOwnershipBtn = document.getElementById('btnBannerTakeOwnership');

    const meta = (pageReviewState[pageId] && pageReviewState[pageId].meta) || {};
    const status = meta.status || 'available';
    const claimant = (meta.claimed_by || '').trim();
    const isMyClaim = claimant.toLowerCase() === getReviewerName().toLowerCase();
    const isEditable = isPageEditable(pageId);
    const isLocked = !isEditable;

    if (badge) {
      badge.className = `status-badge status-${status}`;
      badge.textContent = status.replace('_', ' ');
    }

    if (claimBtn) {
      if (status === 'in_progress' && isMyClaim) {
        claimBtn.textContent = 'Release Page';
        claimBtn.className = 'btn';
        claimBtn.disabled = false;
      } else if (status === 'in_progress' && !isMyClaim) {
        claimBtn.textContent = `Claimed by ${claimant}`;
        claimBtn.className = 'btn btn-primary';
        claimBtn.disabled = false;
      } else if (status === 'merged') {
        claimBtn.textContent = '🔒 Merged';
        claimBtn.disabled = true;
      } else if (status === 'completed') {
        claimBtn.textContent = claimant ? `✓ By ${claimant}` : '✓ Completed';
        claimBtn.className = 'btn';
        claimBtn.disabled = false;
      } else {
        claimBtn.textContent = 'Claim Page';
        claimBtn.className = 'btn btn-primary';
        claimBtn.disabled = false;
      }
    }

    if (completeBtn) {
      if (status === 'merged') {
        completeBtn.style.display = 'none';
        completeBtn.disabled = true;
      } else if (status === 'completed') {
        completeBtn.style.display = 'inline-flex';
        completeBtn.textContent = '↺ Reopen Page';
        completeBtn.className = 'btn';
        completeBtn.disabled = !isMyClaim && status === 'completed';
      } else {
        completeBtn.style.display = 'inline-flex';
        completeBtn.textContent = '✓ Complete Page';
        completeBtn.className = 'btn btn-success';
        completeBtn.disabled = isLocked;
      }
    }

    // Update Lock Banner
    if (lockBanner) {
      if (isLocked) {
        lockBanner.style.display = 'flex';
        if (status === 'merged') {
          lockBanner.className = 'page-lock-banner banner-merged';
          if (lockBannerText) {
            lockBannerText.innerHTML = '🔒 This page has been merged into canonical text and is permanently read-only.';
          }
          if (bannerTakeOwnershipBtn) {
            bannerTakeOwnershipBtn.style.display = 'none';
          }
        } else if (status === 'completed' && claimant && !isMyClaim) {
          lockBanner.className = 'page-lock-banner';
          const isChief = !!(window.AuthGate && typeof window.AuthGate.isMasterEditor === 'function' && window.AuthGate.isMasterEditor());
          if (lockBannerText) {
            lockBannerText.innerHTML = `🔒 This page is <strong>completed and locked</strong> by <strong>${escapeHtml(claimant)}</strong>. It is read-only. ${isChief ? '' : 'Only the person who completed it or the Chief Editor can reopen it.'}`;
          }
          if (bannerTakeOwnershipBtn) {
            // Reopening someone else's completed page is a Chief Editor action
            bannerTakeOwnershipBtn.style.display = isChief ? 'inline-flex' : 'none';
            bannerTakeOwnershipBtn.textContent = 'Reopen (Chief Editor)';
            bannerTakeOwnershipBtn.onclick = () => toggleClaim(pageId);
          }
        } else {
          lockBanner.className = 'page-lock-banner';
          if (lockBannerText) {
            lockBannerText.innerHTML = `🔒 This page is currently claimed by <strong>${escapeHtml(claimant)}</strong>. You are in read-only mode.`;
          }
          if (bannerTakeOwnershipBtn) {
            bannerTakeOwnershipBtn.style.display = 'inline-flex';
            bannerTakeOwnershipBtn.textContent = 'Take Ownership';
            bannerTakeOwnershipBtn.onclick = () => toggleClaim(pageId);
          }
        }
      } else {
        lockBanner.style.display = 'none';
      }
    }

    // Apply lock state to MacroView and MicroView
    if (window.MacroView && typeof window.MacroView.applyLockState === 'function') {
      window.MacroView.applyLockState(isLocked);
    }
    if (window.MicroView && typeof window.MicroView.applyLockState === 'function') {
      window.MicroView.applyLockState(isLocked);
    }
  }

  async function toggleComplete(pageId) {
    const meta = (pageReviewState[pageId] && pageReviewState[pageId].meta) || {};
    const status = meta.status || 'available';
    const claimant = (meta.claimed_by || '').trim();
    const isMyClaim = claimant.toLowerCase() === getReviewerName().toLowerCase();

    if (status === 'merged') return;
    if (status === 'in_progress' && !isMyClaim) {
      alert(`Cannot complete page: this page is claimed by ${claimant}.`);
      return;
    }

    await flushPendingSaves();
    const nextStatus = status === 'completed' ? 'in_progress' : 'completed';
    const updatedMeta = {
      status: nextStatus,
      claimed_by: meta.claimed_by || getReviewerName(),
      last_activity: Date.now()
    };
    await fetchJson(`/reviews/${pageId}/meta.json`, {
      method: 'PUT',
      body: JSON.stringify(updatedMeta)
    });
    if (!pageReviewState[pageId]) {
      pageReviewState[pageId] = { meta: updatedMeta, lines: {} };
    } else {
      pageReviewState[pageId].meta = updatedMeta;
    }
    updatePageStatusBadge(pageId);
    const completeAction = nextStatus === 'completed' ? 'page_completed' : 'page_reopened';
    logEditAudit(pageId, '', nextStatus, true, false, completeAction, '');
  }

  const claimInFlight = new Map();

  async function authedUrl(endpoint) {
    let finalEndpoint = endpoint;
    if (window.AuthGate && typeof window.AuthGate.ensureAuthToken === 'function') {
      const token = await window.AuthGate.ensureAuthToken();
      if (token) {
        finalEndpoint += (finalEndpoint.indexOf('?') >= 0 ? '&auth=' : '?auth=') + encodeURIComponent(token);
      }
    }
    return `${DB_BASE_URL}${finalEndpoint}`;
  }

  /**
   * Compare-and-set on /reviews/<page>/meta. Every change of claimed_by carries
   * takeover_from = the claimant we read; database.rules.json only accepts the write if that
   * still equals the stored claimant, so two simultaneous takeovers cannot both succeed.
   * (Firebase REST ETags are not readable from browsers: Firebase sends no
   * Access-Control-Expose-Headers.)
   * decide(currentMeta) returns the new meta, or null to abort without writing.
   * Returns { ok, meta, aborted, conflict, error }; meta is the latest server meta.
   */
  async function claimMetaAtomic(pageId, decide, maxAttempts = 4) {
    const endpoint = `/reviews/${pageId}/meta.json`;
    let latest = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await fetch(await authedUrl(endpoint));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        latest = (await res.json()) || {};
      } catch (err) {
        console.warn('[ReviewSync] Claim read failed:', err.message);
        return { ok: false, meta: latest, error: true };
      }

      const next = decide(latest);
      if (!next) return { ok: false, meta: latest, aborted: true };

      const prevClaimant = (latest.claimed_by || '');
      const payload = Object.assign({}, next);
      delete payload.takeover_from;
      if (prevClaimant && prevClaimant !== payload.claimed_by) payload.takeover_from = prevClaimant;

      try {
        const put = await fetch(await authedUrl(endpoint), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (put.ok) return { ok: true, meta: payload };
        // 401/403: the rules rejected the write because the claimant changed under us.
        // Re-read and let decide() judge the new state.
        if (put.status !== 401 && put.status !== 403) throw new Error(`HTTP ${put.status}`);
      } catch (err) {
        console.warn('[ReviewSync] Claim write failed:', err.message);
        return { ok: false, meta: latest, error: true };
      }
    }
    return { ok: false, meta: latest, conflict: true };
  }

  function applyServerMeta(pageId, meta) {
    if (!meta) return;
    if (!pageReviewState[pageId]) pageReviewState[pageId] = { meta: {}, lines: {} };
    pageReviewState[pageId].meta = meta;
    updatePageStatusBadge(pageId);
  }

  function lostClaimMessage(meta) {
    const who = (meta && meta.claimed_by) ? meta.claimed_by : 'another reviewer';
    return `${who} claimed this page first. It is now read-only for you.`;
  }

  async function toggleClaim(pageId) {
    const meta = (pageReviewState[pageId] && pageReviewState[pageId].meta) || {};
    const status = meta.status || 'available';
    const claimant = meta.claimed_by || '';
    const me = getReviewerName().toLowerCase();
    const isMyClaim = claimant.toLowerCase() === me;

    if (status === 'in_progress' && isMyClaim) {
      // Release: only if the server still says it is mine
      const res = await claimMetaAtomic(pageId, current => {
        if ((current.claimed_by || '').toLowerCase() !== me) return null;
        return { status: 'available', claimed_by: '', last_activity: Date.now() };
      });
      applyServerMeta(pageId, res.meta);
      return;
    }

    // A completed page is locked: only its completer or the Chief Editor may reopen it
    if (status === 'completed' && claimant && !isMyClaim) {
      const isChief = !!(window.AuthGate && typeof window.AuthGate.isMasterEditor === 'function' && window.AuthGate.isMasterEditor());
      if (!isChief) {
        alert(`This page is completed and locked by ${claimant}. Only they or the Chief Editor can reopen it.`);
        return;
      }
    }

    // Claim or take over
    let confirmedClaimant = null;
    if (status === 'in_progress' && !isMyClaim) {
      const lastAct = meta.last_activity || 0;
      const isStale = (Date.now() - lastAct) > STALE_CLAIM_MS;
      if (!isStale) {
        if (!confirm(`This page is currently claimed by ${claimant}. Take ownership anyway?`)) {
          return;
        }
        confirmedClaimant = claimant.toLowerCase();
      }
    }

    const res = await claimMetaAtomic(pageId, current => {
      const curStatus = current.status || 'available';
      const curClaimant = (current.claimed_by || '').trim();
      if (curStatus === 'merged') return null;
      if (curStatus === 'in_progress' && curClaimant && curClaimant.toLowerCase() !== me) {
        const stale = (Date.now() - (current.last_activity || 0)) > STALE_CLAIM_MS;
        // Only take over the claimant the user actually confirmed; a different claimant means
        // the page changed hands while the prompt was open.
        if (!stale && curClaimant.toLowerCase() !== confirmedClaimant) return null;
      }
      return { status: 'in_progress', claimed_by: getReviewerName(), last_activity: Date.now() };
    });

    applyServerMeta(pageId, res.meta);
    if (!res.ok && res.meta && (res.aborted || res.conflict)) {
      alert(lostClaimMessage(res.meta));
    } else if (!res.ok && res.error) {
      alert('Could not update page ownership. Check your connection and try again.');
    }
  }

  let liveSyncTimer = null;
  let liveEventSource = null;
  let activeSyncPageId = null;

  const EDITS_LOG_STORAGE_KEY = 'ih_edits_audit_log';

  function logEditAudit(pageId, lineId, text, isVerified, isFlagged, action = 'line_edit', originalText = '') {
    try {
      const reviewerName = getReviewerName();
      const reviewerEmail = (window.AuthGate && typeof window.AuthGate.getReviewerEmail === 'function')
        ? window.AuthGate.getReviewerEmail()
        : (localStorage.getItem('ih_reviewer_email') || '');
      const rawLog = localStorage.getItem(EDITS_LOG_STORAGE_KEY);
      const log = rawLog ? JSON.parse(rawLog) : [];

      const record = {
        timestamp: new Date().toISOString(),
        timestamp_ms: Date.now(),
        user: reviewerName,
        email: reviewerEmail,
        page_id: pageId,
        line_id: lineId,
        action: action || 'line_edit',
        original_text: originalText || '',
        text: text || '',
        verified: !!isVerified,
        flagged: !!isFlagged
      };

      log.push(record);
      // Keep up to 5,000 edits in localStorage
      if (log.length > 5000) log.shift();
      localStorage.setItem(EDITS_LOG_STORAGE_KEY, JSON.stringify(log));

      // Push to Firebase RTDB
      fetchJson('/edits_log.json', {
        method: 'POST',
        body: JSON.stringify(record)
      }).catch(err => console.warn('[ReviewSync] RTDB edits_log push failed:', err));

      // Also POST to /api/audit/edits_log if accessible
      try {
        fetch('/api/audit/edits_log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(record)
        }).catch(() => {});
      } catch (e) {}

      // If a webhook or Google Sheets endpoint is configured, POST row asynchronously
      const webhookUrl = (typeof window !== 'undefined' && window.EDITS_SHEET_WEBHOOK_URL) || localStorage.getItem('ih_edits_webhook_url');
      if (webhookUrl) {
        fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(record)
        }).catch(err => console.warn('[ReviewSync] Webhook post failed:', err));
      }
    } catch (e) {
      console.warn('[ReviewSync] Audit log error:', e);
    }
  }

  function getEditsAuditLog() {
    try {
      const raw = localStorage.getItem(EDITS_LOG_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function sanitizeCsvCell(val) {
    if (val === null || val === undefined) return '""';
    let s = String(val);
    // Formula injection mitigation (CWE-1236 / OWASP A03:2021)
    if (/^[=+\-@\t\r]/.test(s)) {
      s = "'" + s;
    }
    s = s.replace(/"/g, '""');
    return `"${s}"`;
  }

  async function exportEditsCsv() {
    if (window.AuthGate && typeof window.AuthGate.verifyMasterPassword === 'function') {
      if (!window.AuthGate.verifyMasterPassword('🔒 Chief Editor Access: Please enter Master Password to export CSV:')) {
        return;
      }
    }

    const combined = [];
    const seen = new Set();

    function addEntry(item) {
      if (!item || typeof item !== 'object') return;
      const key = item.id || `${item.page_id || ''}::${item.line_id || ''}::${item.timestamp || item.timestamp_ms || ''}::${item.user || ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        combined.push(item);
      }
    }

    // 1. Fetch cloud edits_log
    try {
      const cloudLogs = await fetchJson('/edits_log.json');
      if (cloudLogs && typeof cloudLogs === 'object') {
        Object.values(cloudLogs).forEach(addEntry);
      }
    } catch (e) {
      console.warn('[ReviewSync] Cloud edits_log fetch note:', e);
    }

    // 2. Fetch cloud history if present
    try {
      const cloudHistory = await fetchJson('/history.json');
      if (cloudHistory && typeof cloudHistory === 'object') {
        for (const [pageId, lines] of Object.entries(cloudHistory)) {
          if (lines && typeof lines === 'object') {
            for (const [lineId, hEntries] of Object.entries(lines)) {
              if (hEntries && typeof hEntries === 'object') {
                for (const h of Object.values(hEntries)) {
                  if (h && typeof h === 'object') {
                    addEntry({
                      timestamp: h.at ? new Date(h.at).toISOString() : '',
                      timestamp_ms: h.at || 0,
                      user: h.by || '',
                      email: '',
                      page_id: pageId,
                      line_id: lineId,
                      action: 'line_edit',
                      original_text: '',
                      text: h.text || '',
                      verified: false,
                      flagged: false
                    });
                  }
                }
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn('[ReviewSync] Cloud history fetch note:', e);
    }

    // 3. Local cached edits
    getEditsAuditLog().forEach(addEntry);

    if (combined.length === 0) {
      if (typeof alert === 'function') {
        alert('No edits recorded in the audit log yet.');
      }
      return;
    }

    // 4. Sort chronologically ascending by timestamp_ms || timestamp
    combined.sort((a, b) => {
      const tA = Number(a.timestamp_ms) || (a.timestamp ? new Date(a.timestamp).getTime() : 0);
      const tB = Number(b.timestamp_ms) || (b.timestamp ? new Date(b.timestamp).getTime() : 0);
      return tA - tB;
    });

    const headers = [
      'Timestamp',
      'Reviewer Name',
      'Email',
      'Page ID',
      'Line ID',
      'Action',
      'Verified',
      'Flagged',
      'Text',
      'Original Text'
    ];

    const rows = combined.map(item => [
      sanitizeCsvCell(item.timestamp || (item.timestamp_ms ? new Date(item.timestamp_ms).toISOString() : '')),
      sanitizeCsvCell(item.user),
      sanitizeCsvCell(item.email),
      sanitizeCsvCell(item.page_id),
      sanitizeCsvCell(item.line_id),
      sanitizeCsvCell(item.action || 'line_edit'),
      sanitizeCsvCell(item.verified ? 'TRUE' : 'FALSE'),
      sanitizeCsvCell(item.flagged ? 'TRUE' : 'FALSE'),
      sanitizeCsvCell(item.text),
      sanitizeCsvCell(item.original_text || '')
    ]);

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
    if (typeof document !== 'undefined' && typeof Blob !== 'undefined') {
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `iyye_hayyam_edits_log_${new Date().toISOString().slice(0, 10)}.csv`;
        if (document.body && typeof document.body.appendChild === 'function') {
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        } else {
          a.click();
        }
        if (typeof URL.revokeObjectURL === 'function') {
          URL.revokeObjectURL(url);
        }
      }
    }
    return csvContent;
  }

  function saveLine(pageId, lineId, text, isVerified = false) {
    // Check reviewer passcode gate
    if (window.AuthGate && typeof window.AuthGate.checkPasscodeOrPrompt === 'function') {
      if (!window.AuthGate.checkPasscodeOrPrompt('🔒 Enter Reviewer Passcode to edit lines:')) {
        return false;
      }
    }

    if (!isPageEditable(pageId)) {
      console.warn(`[ReviewSync] Save rejected: ${pageId} is currently claimed by another reviewer or locked.`);
      return false;
    }

    hasUnsavedChanges = true;
    updateSyncIndicator('saving');

    // Auto-claim if page is available or unclaimed
    const pageState = pageReviewState[pageId] = pageReviewState[pageId] || { meta: {}, lines: {} };
    const meta = pageState.meta = pageState.meta || {};
    const status = meta.status || 'available';
    const claimant = meta.claimed_by || '';

    if (status === 'available' || !claimant) {
      const myName = getReviewerName();
      meta.status = 'in_progress';
      meta.claimed_by = myName;
      meta.last_activity = Date.now();

      // Update UI badge and claim button immediately (optimistic)
      updatePageStatusBadge(pageId);

      // Persist claim atomically: only if the page is still unclaimed on the server
      const claim = claimMetaAtomic(pageId, current => {
        const curClaimant = (current.claimed_by || '').trim();
        const curStatus = current.status || 'available';
        if (curStatus === 'merged') return null;
        if (curClaimant && curClaimant.toLowerCase() !== myName.toLowerCase()) return null;
        return { status: 'in_progress', claimed_by: myName, last_activity: Date.now() };
      }).then(res => {
        claimInFlight.delete(pageId);
        if (!res.ok && res.meta && (res.aborted || res.conflict)) {
          // Lost the race: drop queued saves for this page and lock the UI
          for (const key of Array.from(pendingSaves.keys())) {
            if (key.startsWith(`${pageId}::`)) pendingSaves.delete(key);
          }
          applyServerMeta(pageId, res.meta);
          alert(lostClaimMessage(res.meta));
        }
        return res;
      });
      claimInFlight.set(pageId, claim);
    }

    const isFlagged = /\?\?(.+?)\?\?/.test(text || '');
    pageState.lines = pageState.lines || {};
    pageState.lines[lineId] = {
      text,
      verified: isVerified,
      flagged: isFlagged,
      edited_by: getReviewerName(),
      updated_at: Date.now()
    };
    // Save immediately to local storage
    saveLocalReview(pageId, pageState);

    let originalText = '';
    if (window.MacroView && typeof window.MacroView.getCurrentPageData === 'function') {
      const pData = window.MacroView.getCurrentPageData();
      if (pData && Array.isArray(pData.lines)) {
        const found = pData.lines.find(l => l.line_id === lineId);
        if (found && found.original_text !== undefined) originalText = found.original_text;
      }
    }
    if (!originalText && pageState.lines && pageState.lines[lineId]) {
      originalText = pageState.lines[lineId].text || '';
    }
    logEditAudit(pageId, lineId, text, isVerified, isFlagged, 'line_edit', originalText);

    const saveKey = `${pageId}::${lineId}`;
    pendingSaves.set(saveKey, {
      pageId,
      lineId,
      text,
      verified: isVerified,
      flagged: isFlagged,
      edited_by: getReviewerName(),
      updated_at: Date.now()
    });

    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushPendingSaves, 500);
    return true;
  }

  async function flushPendingSaves() {
    if (claimInFlight.size > 0) await Promise.all(Array.from(claimInFlight.values()));
    if (pendingSaves.size === 0) return;

    const items = Array.from(pendingSaves.values());
    pendingSaves.clear();

    for (const item of items) {
      const linePayload = {
        text: item.text,
        verified: item.verified,
        flagged: item.flagged,
        edited_by: item.edited_by,
        updated_at: item.updated_at
      };

      // Patch line
      await fetchJson(`/reviews/${item.pageId}/lines/${item.lineId}.json`, {
        method: 'PUT',
        body: JSON.stringify(linePayload)
      });

      // Append to history
      const histPayload = {
        text: item.text,
        by: item.edited_by,
        at: item.updated_at
      };
      await fetchJson(`/history/${item.pageId}/${item.lineId}.json`, {
        method: 'POST',
        body: JSON.stringify(histPayload)
      });

      // Update meta last_activity
      await fetchJson(`/reviews/${item.pageId}/meta/last_activity.json`, {
        method: 'PUT',
        body: JSON.stringify(Date.now())
      });
    }

    hasUnsavedChanges = false;
    updateSyncIndicator('saved');
  }

  function startLiveSync(pageId) {
    stopLiveSync();
    activeSyncPageId = pageId;

    // Polling fallback every 1500ms
    liveSyncTimer = setInterval(() => {
      pollRemoteChanges(pageId);
    }, 1500);

    // EventSource SSE if available
    try {
      if (typeof EventSource !== 'undefined' && DB_BASE_URL && DB_BASE_URL.startsWith('http')) {
        const sseUrl = `${DB_BASE_URL}/reviews/${pageId}.json`;
        liveEventSource = new EventSource(sseUrl);
        liveEventSource.addEventListener('put', (e) => {
          try {
            const data = JSON.parse(e.data);
            if (data && data.path === '/' && data.data) {
              handleRemoteUpdate(pageId, data.data);
            } else if (data && data.path && data.path.startsWith('/lines/')) {
              const lineId = data.path.split('/')[2];
              if (lineId && data.data) {
                const patchObj = { lines: { [lineId]: data.data } };
                handleRemoteUpdate(pageId, patchObj);
              }
            }
          } catch (err) {
            // ignore SSE parse errors
          }
        });
        liveEventSource.onerror = () => {
          if (liveEventSource) {
            liveEventSource.close();
            liveEventSource = null;
          }
        };
      }
    } catch (e) {
      // EventSource fallback to polling
    }
  }

  function stopLiveSync() {
    if (liveSyncTimer) {
      clearInterval(liveSyncTimer);
      liveSyncTimer = null;
    }
    if (liveEventSource) {
      liveEventSource.close();
      liveEventSource = null;
    }
    activeSyncPageId = null;
  }

  async function pollRemoteChanges(pageId) {
    if (!pageId || pageId !== activeSyncPageId) return;
    try {
      const remote = await fetchJson(`/reviews/${pageId}.json`);
      if (remote) {
        handleRemoteUpdate(pageId, remote);
      }
      const suggestions = await fetchJson(`/redline_suggestions/${pageId}.json`);
      if (suggestions) {
        pageSuggestions[pageId] = suggestions;
        if (window.MacroView && window.MacroView.checkAiChips) {
          window.MacroView.checkAiChips();
        }
      }
    } catch (e) {
      // silently retry on next interval
    }
  }

  function handleRemoteUpdate(pageId, remote) {
    const localData = window.MacroView ? window.MacroView.getCurrentPageData() : null;
    if (!localData || !localData.lines) return;

    if (remote.meta) {
      if (!pageReviewState[pageId]) pageReviewState[pageId] = {};
      pageReviewState[pageId].meta = remote.meta;
      updatePageStatusBadge(pageId);
    }

    if (remote.lines) {
      localData.lines.forEach((l, idx) => {
        const rLine = remote.lines[l.line_id];
        if (rLine) {
          const rFlagged = !!rLine.flagged || /\?\?(.+?)\?\?/.test(rLine.text || '');
          const hasDiff = l.text !== rLine.text ||
                          (rLine.verified !== undefined && !!l.verified !== !!rLine.verified) ||
                          (rLine.flagged !== undefined && !!l.flagged !== rFlagged);
          if (hasDiff) {
            const row = document.getElementById(`line-row-${idx}`);
            const textDiv = row ? row.querySelector('.line-text') : null;
            const isLocalActive = textDiv && document.activeElement === textDiv;
            if (!isLocalActive) {
              l.text = rLine.text;
              l.verified = !!rLine.verified;
              l.flagged = rFlagged;
              if (window.MacroView) {
                window.MacroView.updateLineContent(idx, rLine.text, !!l.verified);
              }
              if (window.MicroView && window.MicroView.isOpen && window.MicroView.isOpen() && window.MicroView.getActiveLineIdx() === idx) {
                const microInput = document.getElementById('microTargetInput');
                if (microInput && document.activeElement !== microInput) {
                  microInput.value = rLine.text;
                }
              }
            }
          }
        }
      });
    }
  }

  async function setParagraphBreak(pageId, lineId, action) {
    if (!isPageEditable(pageId)) {
      console.warn(`[ReviewSync] Paragraph break rejected: ${pageId} is currently claimed by another reviewer.`);
      return false;
    }
    updateSyncIndicator('saving');
    await fetchJson(`/reviews/${pageId}/paragraph_breaks/${lineId}.json`, {
      method: 'PUT',
      body: JSON.stringify(action)
    });
    const breakAction = action === 'split' ? 'paragraph_split' : 'paragraph_join';
    logEditAudit(pageId, lineId, action, false, false, breakAction, '');
    updateSyncIndicator('saved');
    return true;
  }

  function getSuggestionForLine(pageId, lineId) {
    const list = pageSuggestions[pageId] || {};
    for (const [id, sug] of Object.entries(list)) {
      if (sug.line_id === lineId) {
        return { ...sug, id };
      }
    }
    return null;
  }

  async function setSuggestionStatus(pageId, suggestionId, status) {
    // Ids come from RTDB keys: never let them add path segments to the write URL.
    const safeId = /^[A-Za-z0-9_-]{1,64}$/;
    if (!safeId.test(String(pageId)) || !safeId.test(String(suggestionId))) {
      console.warn('[ReviewSync] Refusing suggestion status write for unsafe id.');
      return;
    }
    if (status !== 'accepted' && status !== 'rejected' && status !== 'pending') return;
    if (pageSuggestions[pageId] && pageSuggestions[pageId][suggestionId]) {
      pageSuggestions[pageId][suggestionId].status = status;
    }
    await fetchJson(`/redline_suggestions/${encodeURIComponent(pageId)}/${encodeURIComponent(suggestionId)}/status.json`, {
      method: 'PUT',
      body: JSON.stringify(status)
    });
  }

  // Warn on closing tab if unsaved changes exist
  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedChanges || pendingSaves.size > 0) {
      flushPendingSaves();
      e.preventDefault();
      e.returnValue = 'You have unsaved changes.';
    }
  });

  document.addEventListener('DOMContentLoaded', () => {
    updateReviewerBadge();
    document.getElementById('reviewerBadgeBtn')?.addEventListener('click', () => {
      const cur = getReviewerName();
      const nextName = prompt('Enter your reviewer name:', cur === 'Anonymous Reviewer' ? '' : cur);
      if (nextName !== null) {
        setReviewerName(nextName);
      }
    });

    document.getElementById('btnClaimToggle')?.addEventListener('click', () => {
      const pageId = window.MacroView ? window.MacroView.getCurrentPageId() : 'page-05';
      toggleClaim(pageId);
    });

    document.getElementById('btnCompletePage')?.addEventListener('click', () => {
      const pageId = window.MacroView ? window.MacroView.getCurrentPageId() : 'page-05';
      toggleComplete(pageId);
    });

    // Control visibility of navEditorialHub on review.html
    const navEd = document.getElementById('navEditorialHub');
    const myEmail = (window.AuthGate && typeof window.AuthGate.getReviewerEmail === 'function')
      ? window.AuthGate.getReviewerEmail().toLowerCase()
      : (localStorage.getItem('ih_reviewer_email') || '').toLowerCase();
    if (navEd) {
      if (myEmail === 'rhabbaz@gmail.com') {
        navEd.style.display = 'inline-flex';
        navEd.addEventListener('click', (e) => {
          if (window.AuthGate && typeof window.AuthGate.verifyMasterPassword === 'function') {
            const authorized = window.AuthGate.verifyMasterPassword('🔒 Chief Editor Access: Please enter the Master Editor Password:');
            if (!authorized) {
              e.preventDefault();
            }
          }
        });
      } else {
        navEd.style.display = 'none';
      }
    }

    document.getElementById('btnBannerTakeOwnership')?.addEventListener('click', () => {
      const pageId = window.MacroView ? window.MacroView.getCurrentPageId() : 'page-05';
      toggleClaim(pageId);
    });
  });

  return {
    getReviewerName,
    setReviewerName,
    initPage,
    saveLine,
    setParagraphBreak,
    toggleClaim,
    toggleComplete,
    isPageEditable,
    getPageLockInfo,
    getSuggestionForLine,
    setSuggestionStatus,
    startLiveSync,
    stopLiveSync,
    pollRemoteChanges,
    fetchJson,
    logEditAudit,
    getEditsAuditLog,
    sanitizeCsvCell,
    exportEditsCsv
  };
})();
