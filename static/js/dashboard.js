/**
 * dashboard.js
 * 
 * Logic for the 89-page Distribution & Claim Board:
 * - Query param batch assignment highlighting (?reviewer=David&pages=1-10)
 * - Live progress counters and claim states from Firebase RTDB
 * - Interactive filtering by status and claimant
 */

(function() {
  const TOTAL_PAGES = 89;
  let allReviews = {};
  let currentFilter = 'all';
  let highlightedPages = new Set();

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function parseQueryParams() {
    const params = new URLSearchParams(window.location.search);
    const qReviewer = params.get('reviewer');
    if (qReviewer && window.ReviewSync) {
      window.ReviewSync.setReviewerName(qReviewer);
    }

    const qPages = params.get('pages');
    if (qPages) {
      if (qPages.includes('-')) {
        const [start, end] = qPages.split('-').map(Number);
        if (!isNaN(start) && !isNaN(end)) {
          for (let i = start; i <= end; i++) highlightedPages.add(i);
        }
      } else {
        qPages.split(',').map(Number).forEach(num => {
          if (!isNaN(num)) highlightedPages.add(num);
        });
      }
    }
  }

  function updateHeroStats() {
    let completed = 0;
    let inProgress = 0;
    let available = 0;

    for (let i = 1; i <= TOTAL_PAGES; i++) {
      const pid = `page-${String(i).padStart(2, '0')}`;
      const rev = allReviews[pid] || {};
      const status = (rev.meta && rev.meta.status) || 'available';

      if (status === 'completed' || status === 'merged') completed++;
      else if (status === 'in_progress') inProgress++;
      else available++;
    }

    const compEl = document.getElementById('statCompleted');
    if (compEl) compEl.textContent = `${completed} / ${TOTAL_PAGES}`;
    const inProgEl = document.getElementById('statInProgress');
    if (inProgEl) inProgEl.textContent = inProgress;
    const availEl = document.getElementById('statAvailable');
    if (availEl) availEl.textContent = available;
  }

  function renderGrid() {
    const grid = document.getElementById('pageGrid');
    if (!grid) return;
    grid.innerHTML = '';

    const myName = (window.ReviewSync ? window.ReviewSync.getReviewerName() : '').toLowerCase();

    for (let i = 1; i <= TOTAL_PAGES; i++) {
      const pageId = `page-${String(i).padStart(2, '0')}`;
      const rev = allReviews[pageId] || {};
      const meta = rev.meta || {};
      const status = meta.status || 'available';
      const claimant = meta.claimed_by || '';

      // Verification & Flagging tally
      const lines = rev.lines || {};
      const verifiedCount = Object.values(lines).filter(l => l.verified).length;
      const flaggedCount = Object.values(lines).filter(l => l.flagged || /\?\?(.+?)\?\?/.test(l.text || '')).length;

      // Check filters
      if (currentFilter === 'available' && status !== 'available') continue;
      if (currentFilter === 'in_progress' && status !== 'in_progress') continue;
      if (currentFilter === 'completed' && status !== 'completed' && status !== 'merged') continue;
      if (currentFilter === 'flagged' && flaggedCount === 0) continue;
      if (currentFilter === 'my_pages' && claimant.toLowerCase() !== myName) continue;

      const totalEstimated = 43; // Standard average
      const percent = Math.min(100, Math.round((verifiedCount / totalEstimated) * 100));

      const card = document.createElement('a');
      card.href = `review.html?page=${pageId}`;
      card.className = 'page-card';
      if (highlightedPages.has(i)) {
        card.classList.add('highlighted-batch');
      }

      card.innerHTML = `
        <div class="card-thumb-wrap">
          <img class="card-thumb" src="thumbs/${pageId}.webp" alt="Scan Page ${i}" loading="lazy">
        </div>
        <div class="card-content">
          <div class="card-header-row">
            <span class="card-title">Page ${i}</span>
            <span class="status-badge status-${escapeHtml(status)}">${escapeHtml(status.replace('_', ' '))}</span>
          </div>
          <div class="card-progress-bar">
            <div class="card-progress-fill" style="width: ${percent}%;"></div>
          </div>
          <div class="card-footer-row">
            <span>${status === 'merged' ? '🔒 Merged' : status === 'completed' ? `🔒 Completed${claimant ? ` by ${escapeHtml(claimant)}` : ''} · locked` : claimant ? `👤 ${escapeHtml(claimant)}` : '⚪ Available'}</span>
            <span>${flaggedCount > 0 ? `<strong style="color:var(--accent-red); margin-left:6px;">🚩 ${flaggedCount}</strong>` : ''}${verifiedCount > 0 ? `${verifiedCount} lines verified` : ''}</span>
          </div>
        </div>
      `;

      grid.appendChild(card);
    }
  }

  const THEMES = ['dark', 'sepia', 'light'];
  const THEME_LABELS = { dark: '🌙 Dark', sepia: '📜 Sepia', light: '☀️ Light' };

  function initTheme() {
    const savedTheme = localStorage.getItem('ih_theme') || 'dark';
    applyTheme(savedTheme);

    const btn = document.getElementById('dashThemeToggle');
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
    const btn = document.getElementById('dashThemeToggle');
    if (btn) btn.textContent = THEME_LABELS[theme] || theme;
  }

  async function init() {
    // Only display Master Editorial Hub link if logged in as rhabbaz@gmail.com
    const edHub = document.getElementById('btnEditorialHub');
    const myEmail = (window.AuthGate && typeof window.AuthGate.getReviewerEmail === 'function')
      ? window.AuthGate.getReviewerEmail().toLowerCase()
      : (localStorage.getItem('ih_reviewer_email') || '').toLowerCase();

    if (edHub) {
      if (myEmail === 'rhabbaz@gmail.com') {
        edHub.style.display = 'inline-flex';
        edHub.addEventListener('click', (e) => {
          if (window.AuthGate && typeof window.AuthGate.verifyMasterPassword === 'function') {
            const authorized = window.AuthGate.verifyMasterPassword('🔒 Chief Editor Access: Please enter the Master Editor Password:');
            if (!authorized) {
              e.preventDefault();
            }
          }
        });
      } else {
        edHub.style.display = 'none';
      }
    }

    initTheme();
    parseQueryParams();

    const reviewerDisp = document.getElementById('dashReviewerDisplay');
    if (reviewerDisp && window.ReviewSync) {
      reviewerDisp.textContent = window.ReviewSync.getReviewerName();
    }

    document.getElementById('dashReviewerBtn')?.addEventListener('click', () => {
      if (!window.ReviewSync) return;
      const cur = window.ReviewSync.getReviewerName();
      const nextName = prompt('Enter your reviewer name:', cur === 'Anonymous Reviewer' ? '' : cur);
      if (nextName !== null) {
        window.ReviewSync.setReviewerName(nextName);
        if (reviewerDisp) reviewerDisp.textContent = window.ReviewSync.getReviewerName();
        renderGrid();
      }
    });

    document.getElementById('btnExportEdits')?.addEventListener('click', () => {
      if (window.ReviewSync && typeof window.ReviewSync.exportEditsCsv === 'function') {
        window.ReviewSync.exportEditsCsv();
      }
    });

    // Filters
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        renderGrid();
      });
    });

    // Fetch review state
    if (window.ReviewSync) {
      const data = await window.ReviewSync.fetchJson('/reviews.json');
      allReviews = data || {};
    }

    updateHeroStats();
    renderGrid();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
