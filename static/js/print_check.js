(function () {
  'use strict';

  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyBmFOK7Iej8WHSaWyO2RxARVaxrdhdqJds',
    authDomain: 'iyye-hayyam.firebaseapp.com',
    projectId: 'iyye-hayyam'
  };

  const DEFAULT_DB_URL = 'https://iyye-hayyam-default-rtdb.firebaseio.com';
  const CHIEF_EMAIL = 'rhabbaz@gmail.com';
  const DRAFT_KEY = 'ih_print_check_drafts_v1';
  const THEME_KEY = 'ih_print_check_theme';

  let items = [];
  let mine = {};
  let allDocs = {};
  let currentUser = null;
  let idToken = '';
  let sendingIds = new Set();
  let validationNotes = {};

  const els = {
    prog: document.getElementById('prog'),
    meter: document.getElementById('meter'),
    status: document.getElementById('status'),
    signInBtn: document.getElementById('signInBtn'),
    userBadge: document.getElementById('userBadge'),
    signOutBtn: document.getElementById('signOutBtn'),
    chiefBar: document.getElementById('chiefBar'),
    refreshAllBtn: document.getElementById('refreshAllBtn'),
    copyAllJsonBtn: document.getElementById('copyAllJsonBtn'),
    copyBtn: document.getElementById('copyBtn'),
    themeBtn: document.getElementById('themeBtn'),
    authNotice: document.getElementById('authNotice'),
    list: document.getElementById('list')
  };

  function isLocalhost() {
    return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  }

  function resolveDbBaseUrl() {
    if (isLocalhost()) {
      if (typeof window.PRINT_CHECK_DB_URL === 'string' && window.PRINT_CHECK_DB_URL) {
        return window.PRINT_CHECK_DB_URL.replace(/\/+$/, '');
      }
      const param = new URLSearchParams(location.search).get('mock_db');
      if (param) {
        try {
          const parsed = new URL(param, location.origin);
          if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
            return parsed.href.replace(/\/+$/, '');
          }
        } catch (e) {
          /* ignore invalid override */
        }
      }
    }
    return DEFAULT_DB_URL;
  }

  const DB_BASE_URL = resolveDbBaseUrl();

  function getMockAuth() {
    return isLocalhost() && window.__PRINT_CHECK_MOCK_AUTH__ ? window.__PRINT_CHECK_MOCK_AUTH__ : null;
  }

  function setStatus(text) {
    els.status.textContent = text;
  }

  function answered(rec) {
    return Boolean(rec && (rec.choice || (rec.other || '').trim()));
  }

  function isSent(rec) {
    return Boolean(rec && rec.sentAt && rec.sentAt >= (rec.at || ''));
  }

  function saveDrafts() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(mine));
    } catch (e) {
      /* ignore quota/private mode */
    }
  }

  function loadDrafts() {
    try {
      const raw = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
      return raw && typeof raw === 'object' ? raw : {};
    } catch (e) {
      return {};
    }
  }

  function applyTheme(theme) {
    if (theme === 'dark' || theme === 'light') {
      document.documentElement.setAttribute('data-theme', theme);
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch (e) {}
    } else {
      document.documentElement.removeAttribute('data-theme');
      try {
        localStorage.removeItem(THEME_KEY);
      } catch (e) {}
    }
    const isDark = isDarkActive();
    els.themeBtn.textContent = isDark ? 'Light mode' : 'Dark mode';
    els.themeBtn.setAttribute('aria-pressed', String(isDark));
  }

  function isDarkActive() {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark') return true;
    if (attr === 'light') return false;
    return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function initTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem(THEME_KEY);
    } catch (e) {}
    applyTheme(saved === 'dark' || saved === 'light' ? saved : null);
    els.themeBtn.addEventListener('click', () => {
      applyTheme(isDarkActive() ? 'light' : 'dark');
    });
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => {
        if (!document.documentElement.getAttribute('data-theme')) {
          applyTheme(null);
        }
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function renderQuestion(parent, item) {
    if (!Array.isArray(item.question_parts)) {
      parent.textContent = item.question || '';
      return;
    }
    for (const part of item.question_parts) {
      if (typeof part === 'string') {
        parent.appendChild(document.createTextNode(part));
      } else if (part && typeof part.he === 'string') {
        const bdi = el('bdi', 'q-he', part.he);
        bdi.dir = 'rtl';
        bdi.lang = 'he';
        parent.appendChild(bdi);
      } else if (part && Array.isArray(part.he_quote)) {
        parent.appendChild(document.createTextNode('\u201C'));
        const bdi = el('bdi', 'q-he');
        bdi.dir = 'rtl';
        bdi.lang = 'he';
        for (const sub of part.he_quote) {
          if (typeof sub === 'string') {
            bdi.appendChild(document.createTextNode(sub));
          } else if (sub && typeof sub.blank === 'string') {
            const blank = el('span', 'q-blank', sub.blank);
            blank.setAttribute('aria-label', 'blank');
            bdi.appendChild(blank);
          }
        }
        parent.appendChild(bdi);
        parent.appendChild(document.createTextNode('\u201D'));
      }
    }
  }

  function parseBoldRuns(text) {
    const runs = [];
    const re = /\*\*(.+?)\*\*/g;
    let last = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match.index > last) {
        runs.push({ text: text.slice(last, match.index), bold: false });
      }
      runs.push({ text: match[1], bold: true });
      last = match.index + match[0].length;
    }
    if (last < text.length) {
      runs.push({ text: text.slice(last), bold: false });
    }
    return runs.length ? runs : [{ text: text, bold: false }];
  }

  function appendRunSlice(parent, runs, s0, s1) {
    if (s1 <= s0) return;
    let offset = 0;
    for (const run of runs) {
      const r0 = offset;
      const r1 = offset + run.text.length;
      offset = r1;
      const a = Math.max(r0, s0);
      const b = Math.min(r1, s1);
      if (b <= a) continue;
      const slice = run.text.slice(a - r0, b - r0);
      if (run.bold) {
        parent.appendChild(el('b', null, slice));
      } else {
        parent.appendChild(document.createTextNode(slice));
      }
    }
  }

  function renderLineText(parent, text, mark) {
    const runs = parseBoldRuns(String(text || ''));
    const plain = runs.map(r => r.text).join('');
    const markIdx = mark ? plain.indexOf(mark) : -1;
    if (markIdx < 0) {
      appendRunSlice(parent, runs, 0, plain.length);
      return;
    }
    const markEnd = markIdx + mark.length;
    appendRunSlice(parent, runs, 0, markIdx);
    const mk = document.createElement('mark');
    appendRunSlice(mk, runs, markStartOrZero(markIdx), markEnd);
    parent.appendChild(mk);
    appendRunSlice(parent, runs, markEnd, plain.length);
  }

  function markStartOrZero(n) {
    return n > 0 ? n : 0;
  }

  function buildFullPageLink(href, label) {
    const a = el('a', 'full-page-link', label);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  function buildSlip(item) {
    const slip = el('section', 'slip');
    slip.dataset.id = item.id;

    const form = el('form', 'slip-form');
    form.setAttribute('aria-labelledby', 'h-' + item.n);
    form.noValidate = true;

    const head = el('div', 'head');
    head.id = 'h-' + item.n;
    head.appendChild(el('span', 'num', String(item.n)));

    const leafEl = el('bdi', 'loc leaf', item.leaf);
    leafEl.dir = 'rtl';
    leafEl.lang = 'he';
    head.appendChild(leafEl);
    head.appendChild(el('span', null, item.where));
    head.appendChild(buildFullPageLink(item.full_page, `Full page (scan ${item.scan}) \u2197`));
    const savedEl = el('span', 'saved');
    savedEl.setAttribute('data-saved', '');
    head.appendChild(savedEl);
    form.appendChild(head);

    const qEl = el('p', 'q');
    renderQuestion(qEl, item);
    form.appendChild(qEl);

    const textBox = el('div', 'text');
    textBox.dir = 'rtl';
    textBox.lang = 'he';
    if (item.prev) {
      const prevRow = el('div', 'ctx');
      renderLineText(prevRow, item.prev, '');
      textBox.appendChild(prevRow);
    }
    const mainRow = document.createElement('div');
    renderLineText(mainRow, item.line, item.mark);
    textBox.appendChild(mainRow);
    if (item.next) {
      const nextRow = el('div', 'ctx');
      renderLineText(nextRow, item.next, '');
      textBox.appendChild(nextRow);
    }
    form.appendChild(textBox);

    if (item.crop) {
      const fig = document.createElement('figure');
      fig.tabIndex = 0;
      fig.setAttribute('role', 'region');
      fig.setAttribute('aria-label', `Scan crop for item ${item.n}`);

      const img = document.createElement('img');
      img.src = item.crop;
      if (item.crop_width) img.width = item.crop_width;
      if (item.crop_height) img.height = item.crop_height;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = `Scan of the line on ${item.leaf}`;
      fig.appendChild(img);

      const cap = document.createElement('figcaption');
      const captionText = els.list.dataset.scanCaption ||
        'Our scan: the line in question is boxed, with the lines above and below it.';
      cap.appendChild(document.createTextNode(captionText));
      cap.appendChild(buildFullPageLink(item.full_page, 'Open full page scan \u2197'));
      fig.appendChild(cap);
      form.appendChild(fig);
    }

    const fs = document.createElement('fieldset');
    const legendText = els.list.dataset.legend ||
      'What does your copy print at the highlighted spot?';
    fs.appendChild(el('legend', null, legendText));
    const optsWrap = el('div', 'opts');
    const a = mine[item.id] || {};
    (item.options || []).forEach((opt, idx) => {
      const lbl = el('label', 'opt');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'c-' + item.id;
      radio.id = `c-${item.id}-${idx}`;
      radio.value = opt;
      if (a.choice === opt) {
        radio.checked = true;
        lbl.classList.add('sel');
      }
      const txt = el('bdi', 'he', opt);
      txt.dir = 'rtl';
      txt.lang = 'he';
      lbl.appendChild(radio);
      lbl.appendChild(txt);
      optsWrap.appendChild(lbl);
    });
    fs.appendChild(optsWrap);
    form.appendChild(fs);

    const row = el('div', 'row');
    const otherField = el('div', 'field');
    const otherLbl = el('label', null, 'Something else (type what the print shows)');
    otherLbl.htmlFor = 'o-' + item.id;
    const otherInp = document.createElement('input');
    otherInp.type = 'text';
    otherInp.id = 'o-' + item.id;
    otherInp.name = 'other';
    otherInp.className = 'he';
    otherInp.dir = 'rtl';
    otherInp.lang = 'he';
    otherInp.maxLength = 200;
    otherInp.value = a.other || '';
    otherField.appendChild(otherLbl);
    otherField.appendChild(otherInp);

    const commentField = el('div', 'field');
    const commentLbl = el('label', null, 'Comment (optional)');
    commentLbl.htmlFor = 'm-' + item.id;
    const commentInp = document.createElement('textarea');
    commentInp.id = 'm-' + item.id;
    commentInp.name = 'comment';
    commentInp.maxLength = 1000;
    commentInp.value = a.comment || '';
    commentField.appendChild(commentLbl);
    commentField.appendChild(commentInp);

    row.appendChild(otherField);
    row.appendChild(commentField);
    form.appendChild(row);

    const sendRow = el('div', 'send');
    const sendBtn = el('button', 'sendBtn', 'Send this answer');
    sendBtn.type = 'submit';
    sendBtn.setAttribute('data-send', '');
    const sstate = el('span', 'sstate');
    sstate.setAttribute('data-sstate', '');
    sstate.setAttribute('role', 'status');
    sstate.setAttribute('aria-live', 'polite');
    sendRow.appendChild(sendBtn);
    sendRow.appendChild(sstate);
    form.appendChild(sendRow);

    const theirsBox = el('div', 'theirs');
    theirsBox.setAttribute('data-theirs', '');
    theirsBox.hidden = true;
    form.appendChild(theirsBox);

    slip.appendChild(form);
    return slip;
  }

  function updateSlipState(slip) {
    const id = slip.dataset.id;
    const a = mine[id];
    const btn = slip.querySelector('[data-send]');
    const st = slip.querySelector('[data-sstate]');
    const savedEl = slip.querySelector('[data-saved]');
    const otherInp = slip.querySelector('input[name="other"]');
    const sending = sendingIds.has(id);
    const sent = isSent(a);
    const ok = answered(a);
    const vnote = validationNotes[id] || '';

    btn.disabled = sending || sent;
    if (sending) {
      btn.textContent = 'Sending\u2026';
    } else if (sent) {
      btn.textContent = 'Sent';
    } else if (a && a.sentAt) {
      btn.textContent = 'Send the change';
    } else {
      btn.textContent = 'Send this answer';
    }

    st.className = 'sstate';
    if (vnote) {
      st.classList.add('err');
      st.textContent = vnote;
      if (otherInp && vnote.indexOf('Pick a reading') === 0) {
        otherInp.setAttribute('aria-invalid', 'true');
      }
    } else {
      if (otherInp) otherInp.removeAttribute('aria-invalid');
      if (sent) {
        st.classList.add('ok');
        const ts = new Date(a.sentAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
        st.textContent = `\u2713 Sent ${ts}`;
      } else if (!ok) {
        st.textContent = 'Pick a reading or type one';
      } else if (!currentUser) {
        st.textContent = 'Draft saved locally — sign in with Google to send';
      } else if (a && a.sentAt) {
        st.textContent = 'Changed since you sent it';
      } else {
        st.textContent = 'Ready to send';
      }
    }

    slip.classList.toggle('done', sent);
    savedEl.textContent = sent ? 'Sent' : '';
  }

  function updateProgress() {
    const total = items.length || 14;
    const sentCount = items.filter(it => isSent(mine[it.id])).length;
    els.prog.textContent = `${sentCount} of ${total} sent`;
    els.meter.max = total;
    els.meter.value = sentCount;
  }

  function renderAllSlips() {
    els.list.textContent = '';
    const frag = document.createDocumentFragment();
    for (const item of items) {
      frag.appendChild(buildSlip(item));
    }
    els.list.appendChild(frag);
    els.list.setAttribute('aria-busy', 'false');
    els.list.querySelectorAll('.slip').forEach(updateSlipState);
    updateProgress();
    renderAllResponses();
  }

  function isChiefEditor() {
    return Boolean(
      currentUser &&
      currentUser.emailVerified &&
      String(currentUser.email || '').toLowerCase() === CHIEF_EMAIL
    );
  }

  function updateAuthUI() {
    if (currentUser) {
      const label = currentUser.displayName || currentUser.email || 'Signed in';
      els.signInBtn.hidden = true;
      els.userBadge.hidden = false;
      els.userBadge.textContent = `${label} (${currentUser.email})`;
      els.signOutBtn.hidden = false;
      els.authNotice.hidden = true;
      els.chiefBar.hidden = !isChiefEditor();
      setStatus(isChiefEditor() ? 'Signed in as Chief Editor' : 'Ready: send each answer when you have it');
    } else {
      els.signInBtn.hidden = false;
      els.userBadge.hidden = true;
      els.userBadge.textContent = '';
      els.signOutBtn.hidden = true;
      els.chiefBar.hidden = true;
      els.authNotice.hidden = false;
      setStatus('Draft mode (sign in with Google to send answers)');
    }
    els.list.querySelectorAll('.slip').forEach(updateSlipState);
  }

  function renderAllResponses() {
    const show = isChiefEditor() && allDocs && typeof allDocs === 'object';
    els.list.querySelectorAll('.slip').forEach(slip => {
      const id = slip.dataset.id;
      const box = slip.querySelector('[data-theirs]');
      box.textContent = '';
      if (!show) {
        box.hidden = true;
        return;
      }
      const rows = [];
      for (const [uid, doc] of Object.entries(allDocs)) {
        if (!doc || typeof doc !== 'object') continue;
        const ans = doc.items && doc.items[id];
        if (!answered(ans)) continue;
        const who = doc.displayName || doc.email || uid;
        const row = document.createElement('div');
        row.appendChild(el('b', null, `${who}: `));
        const val = el('bdi', 'q-he', ans.other || ans.choice);
        val.dir = 'rtl';
        val.lang = 'he';
        row.appendChild(val);
        if (ans.comment) {
          row.appendChild(document.createTextNode(` \u2014 ${ans.comment}`));
        }
        rows.push(row);
      }
      if (!rows.length) {
        box.hidden = true;
        return;
      }
      box.appendChild(el('div', null, 'Answers so far'));
      rows.forEach(r => box.appendChild(r));
      box.hidden = false;
    });
  }

  async function getFreshToken(forceRefresh) {
    if (!currentUser) return '';
    const tok = await currentUser.getIdToken(Boolean(forceRefresh));
    idToken = tok || '';
    return idToken;
  }

  async function fetchWithAuth(url, options) {
    let tok = idToken || (await getFreshToken(false));
    const sep = url.indexOf('?') >= 0 ? '&' : '?';
    let res = await fetch(`${url}${sep}auth=${encodeURIComponent(tok)}`, options);
    if (res.status === 401 && currentUser) {
      tok = await getFreshToken(true);
      res = await fetch(`${url}${sep}auth=${encodeURIComponent(tok)}`, options);
    }
    return res;
  }

  async function loadMyStoredAnswers() {
    if (!currentUser) return;
    try {
      const url = `${DB_BASE_URL}/print_check_answers/${encodeURIComponent(currentUser.uid)}.json`;
      const res = await fetchWithAuth(url, { method: 'GET' });
      if (!res.ok) return;
      const doc = await res.json();
      const stored = doc && doc.items && typeof doc.items === 'object' ? doc.items : {};
      const merged = Object.assign({}, stored);
      for (const [k, v] of Object.entries(mine)) {
        if (!merged[k] || (v && (v.at || '') > (merged[k].at || ''))) {
          merged[k] = Object.assign({}, v, { sentAt: (stored[k] && stored[k].sentAt) || '' });
        }
      }
      mine = merged;
      saveDrafts();
      syncInputsFromMine();
      updateProgress();
      els.list.querySelectorAll('.slip').forEach(updateSlipState);
    } catch (e) {
      /* keep local drafts if offline */
    }
  }

  async function loadAllResponses() {
    if (!isChiefEditor()) return;
    try {
      const res = await fetchWithAuth(`${DB_BASE_URL}/print_check_answers.json`, { method: 'GET' });
      if (!res.ok) {
        setStatus(`Could not load checker answers (${res.status})`);
        return;
      }
      const data = await res.json();
      allDocs = data && typeof data === 'object' ? data : {};
      renderAllResponses();
    } catch (e) {
      setStatus('Could not load checker answers right now');
    }
  }

  function syncInputsFromMine() {
    els.list.querySelectorAll('.slip').forEach(slip => {
      const id = slip.dataset.id;
      const a = mine[id] || {};
      slip.querySelectorAll('input[type="radio"]').forEach(r => {
        const matched = r.value === a.choice;
        r.checked = matched;
        const optLbl = r.closest('.opt');
        if (optLbl) optLbl.classList.toggle('sel', matched);
      });
      const otherInp = slip.querySelector('input[name="other"]');
      if (otherInp) otherInp.value = a.other || '';
      const commentInp = slip.querySelector('textarea[name="comment"]');
      if (commentInp) commentInp.value = a.comment || '';
    });
  }

  function onSlipInput(slip) {
    const id = slip.dataset.id;
    const sel = slip.querySelector('input[type="radio"]:checked');
    const prev = mine[id] || {};
    const otherVal = slip.querySelector('input[name="other"]').value;
    const commentVal = slip.querySelector('textarea[name="comment"]').value;

    mine[id] = {
      choice: sel ? sel.value : '',
      other: otherVal,
      comment: commentVal,
      at: new Date().toISOString(),
      sentAt: prev.sentAt || ''
    };
    delete validationNotes[id];

    slip.querySelectorAll('.opt').forEach(o => {
      o.classList.toggle('sel', o.querySelector('input').checked);
    });
    saveDrafts();
    updateSlipState(slip);
    updateProgress();
  }

  async function submitSlip(slip) {
    const id = slip.dataset.id;
    const rec = mine[id] || {};
    if (!answered(rec)) {
      validationNotes[id] = 'Pick a reading or type one first';
      updateSlipState(slip);
      const firstRadio = slip.querySelector('input[type="radio"]');
      if (firstRadio) firstRadio.focus();
      return;
    }
    if (!currentUser) {
      validationNotes[id] = 'Sign in with Google first (or use Copy my answers)';
      updateSlipState(slip);
      els.signInBtn.focus();
      return;
    }
    if (sendingIds.has(id)) return;

    delete validationNotes[id];
    sendingIds.add(id);
    updateSlipState(slip);

    const now = new Date().toISOString();
    const itemRec = {
      choice: rec.choice || '',
      other: (rec.other || '').trim(),
      comment: rec.comment || '',
      at: rec.at || now,
      sentAt: now
    };
    const payload = {
      displayName: (currentUser.displayName || currentUser.email.split('@')[0]).slice(0, 100),
      email: String(currentUser.email).trim().toLowerCase(),
      updatedAt: now,
      ['items/' + id]: itemRec
    };

    try {
      const url = `${DB_BASE_URL}/print_check_answers/${encodeURIComponent(currentUser.uid)}.json`;
      const res = await fetchWithAuth(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      mine[id] = itemRec;
      saveDrafts();
      setStatus(`Saved item ${slip.querySelector('.num').textContent}`);
      if (isChiefEditor()) {
        await loadAllResponses();
      }
    } catch (err) {
      validationNotes[id] = 'Send failed — try again or use Copy my answers';
      setStatus('Could not send that answer');
    } finally {
      sendingIds.delete(id);
      updateSlipState(slip);
      updateProgress();
    }
  }

  function handleSignInClick() {
    const mockAuth = getMockAuth();
    if (mockAuth && typeof mockAuth.signIn === 'function') {
      Promise.resolve(mockAuth.signIn()).then(user => applySignedInUser(user));
      return;
    }
    if (!(window.firebase && window.firebase.auth)) {
      setStatus('Sign-in SDK is still loading — try again in a moment');
      return;
    }
    if (!window.firebase.apps.length) {
      window.firebase.initializeApp(FIREBASE_CONFIG);
    }
    const provider = new window.firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    // Invoke popup synchronously inside click gesture so browsers do not block it.
    window.firebase.auth().signInWithPopup(provider).then(async res => {
      const user = res && res.user;
      if (!user || !user.email) return;
      if (!user.emailVerified) {
        await window.firebase.auth().signOut();
        setStatus('Your Google account email must be verified to submit answers');
        return;
      }
      await applySignedInUser(user);
    }).catch(err => {
      const code = err && err.code;
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        setStatus('Google sign-in was cancelled');
      } else if (code === 'auth/popup-blocked') {
        setStatus('Popup was blocked by your browser — allow popups and try again');
      } else {
        setStatus('Google sign-in failed: ' + ((err && err.message) || 'unknown error'));
      }
    });
  }

  function handleSignOutClick() {
    const mockAuth = getMockAuth();
    if (mockAuth && typeof mockAuth.signOut === 'function') {
      mockAuth.signOut();
    } else if (window.firebase && window.firebase.auth) {
      window.firebase.auth().signOut().catch(() => {});
    }
    currentUser = null;
    idToken = '';
    allDocs = {};
    validationNotes = {};
    updateAuthUI();
    renderAllResponses();
  }

  async function applySignedInUser(user) {
    if (!user || !user.email || !user.emailVerified) {
      currentUser = null;
      idToken = '';
      updateAuthUI();
      return;
    }
    currentUser = user;
    await getFreshToken(false);
    updateAuthUI();
    await loadMyStoredAnswers();
    if (isChiefEditor()) {
      await loadAllResponses();
    }
  }

  function initAuth() {
    const mockAuth = getMockAuth();
    if (mockAuth) {
      if (mockAuth.currentUser) {
        applySignedInUser(mockAuth.currentUser);
      } else {
        updateAuthUI();
      }
      return;
    }
    if (window.firebase && window.firebase.auth) {
      if (!window.firebase.apps.length) {
        window.firebase.initializeApp(FIREBASE_CONFIG);
      }
      window.firebase.auth().onAuthStateChanged(user => {
        if (user && user.emailVerified) {
          applySignedInUser(user);
        } else {
          currentUser = null;
          idToken = '';
          updateAuthUI();
        }
      });
    } else {
      updateAuthUI();
    }
  }

  function formatCopyText() {
    return items.map(it => {
      const a = mine[it.id] || {};
      const val = (a.other || '').trim() || a.choice || '\u2014';
      const note = a.comment ? ` | ${a.comment}` : '';
      return `${it.n}. ${it.leaf} (scan ${it.scan}, ${it.id}): ${val}${note}`;
    }).join('\n');
  }

  async function copyTextWithFallback(txt, okMsg) {
    try {
      await navigator.clipboard.writeText(txt);
      setStatus(okMsg);
    } catch (e) {
      let box = document.getElementById('copyFallbackBox');
      if (!box) {
        box = el('textarea', 'copy-fallback-box');
        box.id = 'copyFallbackBox';
        box.setAttribute('aria-label', 'Copied text');
        els.authNotice.insertAdjacentElement('afterend', box);
      }
      box.value = txt;
      box.hidden = false;
      box.select();
      setStatus('Select and copy the text box below');
    }
  }

  function wireEvents() {
    els.list.addEventListener('input', e => {
      const slip = e.target.closest('.slip');
      if (slip) onSlipInput(slip);
    });
    els.list.addEventListener('change', e => {
      const slip = e.target.closest('.slip');
      if (slip && e.target.type === 'radio') onSlipInput(slip);
    });
    els.list.addEventListener('submit', e => {
      const slip = e.target.closest('.slip');
      if (!slip) return;
      e.preventDefault();
      submitSlip(slip);
    });
    els.signInBtn.addEventListener('click', handleSignInClick);
    els.signOutBtn.addEventListener('click', handleSignOutClick);
    els.copyBtn.addEventListener('click', () => {
      copyTextWithFallback(formatCopyText(), 'Answers copied to clipboard');
    });
    els.refreshAllBtn.addEventListener('click', () => {
      loadAllResponses();
    });
    els.copyAllJsonBtn.addEventListener('click', () => {
      copyTextWithFallback(JSON.stringify(allDocs, null, 2), 'All checker responses copied as JSON');
    });
  }

  async function init() {
    initTheme();
    mine = loadDrafts();
    wireEvents();

    try {
      const res = await fetch('items.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      items = await res.json();
      renderAllSlips();
      initAuth();
    } catch (err) {
      els.list.setAttribute('aria-busy', 'false');
      setStatus('Could not load print-check items');
      const errBox = el('div', 'notice err', 'Failed to load items.json. Please reload the page.');
      els.list.appendChild(errBox);
    }
  }

  init();
})();
