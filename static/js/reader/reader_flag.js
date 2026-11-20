// Public reader M4: Google-verified flagging UI & redline_suggestions writer.
// Builds DOM safely via textContent/nodes only, keeps silent flag-only identity,
// and requires explicit endpoint config or local emulator override (never live RTDB).
(function (root) {
  'use strict';

  var AUTH_STORAGE_KEY = 'ih_reader_flag_auth';
  var SENT_STORAGE_KEY = 'ih_reader_flags_sent';
  var EMU_STORAGE_KEY = 'ih_reader_emulator_url';
  var VALID_KINDS = ['word', 'missing', 'format', 'footnote', 'translation'];
  var VALID_TARGETS = ['line', 'translation'];
  var SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  var SAFE_PAGE_RE = /^page-[0-9]{2}$/;

  var state = {
    initialized: false,
    mountEl: null,
    barSlotEl: null,
    streamEl: null,
    inertEl: null,
    getPageData: null,
    getCurrentPage: null,
    getLineContext: null,
    config: {},
    memorySession: null,
    activeTarget: null,
    triggerEl: null,
    ctxTarget: null,
    dom: {}
  };

  function safeStorageGet(key) {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    } catch (e) {
      return null;
    }
  }

  function safeStorageSet(key, val) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, val);
    } catch (e) {}
  }

  function safeStorageRemove(key) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
    } catch (e) {}
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function appendRich(parent, text) {
    var str = String(text == null ? '' : text);
    var parts = str.split(/\*\*(.+?)\*\*/g);
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (i % 2 === 1) {
        var b = document.createElement('b');
        b.textContent = parts[i];
        parent.appendChild(b);
      } else {
        parent.appendChild(document.createTextNode(parts[i]));
      }
    }
  }

  function normalizePageId(pageIdOrN) {
    if (typeof pageIdOrN === 'number' && isFinite(pageIdOrN)) {
      var n = Math.round(pageIdOrN);
      if (n < 1 || n > 99) return null;
      return 'page-' + (n < 10 ? '0' : '') + n;
    }
    var s = String(pageIdOrN == null ? '' : pageIdOrN).trim();
    if (SAFE_PAGE_RE.test(s)) return s;
    var m = /^(?:page-)?(\d{1,2})$/.exec(s);
    if (!m) return null;
    var num = parseInt(m[1], 10);
    if (num < 1 || num > 99) return null;
    return 'page-' + (num < 10 ? '0' : '') + num;
  }

  function normalizeLineId(rawId) {
    var s = String(rawId == null ? '' : rawId).trim();
    if (s.charAt(0) === '[' && s.charAt(s.length - 1) === ']') {
      s = s.slice(1, -1).trim();
    }
    return SAFE_ID_RE.test(s) ? s : null;
  }

  function domToMarkup(node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.textContent || '';
    if (node.nodeType !== 1) return '';
    var children = node.childNodes || [];
    var out = '';
    for (var i = 0; i < children.length; i++) {
      out += domToMarkup(children[i]);
    }
    var tag = (node.tagName || '').toUpperCase();
    if (tag === 'B' || tag === 'STRONG') {
      if (!out) return '';
      if (out.slice(0, 2) === '**' && out.slice(-2) === '**' && out.length > 4) return out;
      return '**' + out + '**';
    }
    return out;
  }

  function toggleBoldInTextarea(textarea) {
    if (!textarea || typeof textarea.value !== 'string') return '';
    var val = textarea.value;
    var start = typeof textarea.selectionStart === 'number' ? textarea.selectionStart : 0;
    var end = typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : start;
    if (end < start) {
      var tmp = start;
      start = end;
      end = tmp;
    }
    if (start === end) {
      // Expand to word boundaries around caret
      while (start > 0 && !/\s/.test(val.charAt(start - 1))) start--;
      while (end < val.length && !/\s/.test(val.charAt(end))) end++;
    }
    if (start === end) {
      textarea.focus && textarea.focus();
      return val;
    }
    var selected = val.slice(start, end);
    var nextVal;
    var nextStart = start;
    var nextEnd = end;
    if (selected.length >= 4 && selected.slice(0, 2) === '**' && selected.slice(-2) === '**') {
      var unwrapped = selected.slice(2, -2);
      nextVal = val.slice(0, start) + unwrapped + val.slice(end);
      nextEnd = start + unwrapped.length;
    } else if (start >= 2 && val.slice(start - 2, start) === '**' && val.slice(end, end + 2) === '**') {
      nextVal = val.slice(0, start - 2) + selected + val.slice(end + 2);
      nextStart = start - 2;
      nextEnd = end - 2;
    } else {
      var wrapped = '**' + selected + '**';
      nextVal = val.slice(0, start) + wrapped + val.slice(end);
      nextEnd = start + wrapped.length;
    }
    textarea.value = nextVal;
    if (typeof textarea.setSelectionRange === 'function') {
      textarea.setSelectionRange(nextStart, nextEnd);
    } else {
      textarea.selectionStart = nextStart;
      textarea.selectionEnd = nextEnd;
    }
    if (typeof textarea.focus === 'function') textarea.focus();
    return nextVal;
  }

  function makeSuggestionId(uid, nowMs, randStr) {
    var cleanUid = String(uid == null ? '' : uid).trim();
    if (!cleanUid || !/^[A-Za-z0-9_-]{1,62}$/.test(cleanUid)) return '';
    var ts = (typeof nowMs === 'number' && isFinite(nowMs) ? Math.floor(nowMs) : Date.now()).toString(36);
    var rnd = (randStr != null ? String(randStr) : Math.random().toString(36).slice(2, 8))
      .replace(/[^A-Za-z0-9_-]/g, '');
    if (!rnd) rnd = '0';
    var maxSuffix = 64 - cleanUid.length - 1;
    var rawSuffix = maxSuffix >= ts.length + 2 ? (ts + '_' + rnd) : (ts + rnd);
    var suffix = rawSuffix.slice(0, maxSuffix);
    if (!suffix) suffix = '0';
    return cleanUid + '_' + suffix;
  }

  function buildSuggestionPayload(opts) {
    var o = opts || {};
    var uid = String(o.uid == null ? '' : o.uid).trim();
    if (!uid || uid.length > 128 || !/^[A-Za-z0-9_-]{1,62}$/.test(uid)) {
      return { ok: false, error: 'מזהה משתמש (UID) לא תקין' };
    }
    var pageId = normalizePageId(o.pageId);
    if (!pageId) {
      return { ok: false, error: 'מספר עמוד לא תקין' };
    }
    var lineId = normalizeLineId(o.lineId);
    if (!lineId) {
      return { ok: false, error: 'מזהה שורה חסר או לא תקין' };
    }
    var kind = o.kind != null ? String(o.kind).trim() : 'word';
    if (VALID_KINDS.indexOf(kind) === -1) {
      return { ok: false, error: 'סוג דיווח לא תקין' };
    }
    var target = o.target != null ? String(o.target).trim() : 'line';
    if (VALID_TARGETS.indexOf(target) === -1) {
      return { ok: false, error: 'יעד דיווח לא תקין' };
    }

    var createdAt = typeof o.createdAt === 'number' && isFinite(o.createdAt) ? Math.floor(o.createdAt) : Date.now();
    var suggestionId = makeSuggestionId(uid, createdAt, o.randStr);
    if (!suggestionId || !SAFE_ID_RE.test(suggestionId) || suggestionId.indexOf(uid + '_') !== 0) {
      return { ok: false, error: 'לא ניתן ליצור מזהה הצעה תקין' };
    }

    var payload = {
      status: 'pending',
      source: 'reader',
      line_id: lineId,
      kind: kind,
      target: target,
      by_uid: uid,
      created_at: createdAt
    };

    if (o.para !== undefined && o.para !== null && o.para !== '') {
      var paraNum = Number(o.para);
      if (!isFinite(paraNum) || Math.floor(paraNum) !== paraNum || paraNum < 0 || paraNum > 99) {
        return { ok: false, error: 'מספר פסקה לא תקין' };
      }
      payload.para = paraNum;
    }

    if (o.proposedText != null && String(o.proposedText).length > 0) {
      var proposed = String(o.proposedText);
      if (proposed.length > 1000) return { ok: false, error: 'הטקסט המוצע ארוך מ-1000 תווים' };
      payload.proposed_text = proposed; // preserves **...** bold markup verbatim
    }

    if (o.reason != null && String(o.reason).trim().length > 0) {
      var reason = String(o.reason).trim();
      if (reason.length > 500) return { ok: false, error: 'הסיבה ארוכה מ-500 תווים' };
      payload.reason = reason;
    }

    if (o.note != null && String(o.note).trim().length > 0) {
      var note = String(o.note).trim();
      if (note.length > 1000) return { ok: false, error: 'ההערה ארוכה מ-1000 תווים' };
      payload.note = note;
    }

    if (o.displayName != null && String(o.displayName).trim().length > 0) {
      var byName = String(o.displayName).trim().slice(0, 100);
      payload.by_name = byName;
    }

    return {
      ok: true,
      pageId: pageId,
      suggestionId: suggestionId,
      payload: payload
    };
  }

  function isLocalHostname(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1';
  }

  function isLocalEmulatorUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(rawUrl.trim());
  }

  function resolveDbConfig(explicitConfig, loc) {
    var cfg = explicitConfig || {};
    var g = typeof window !== 'undefined' ? window : {};
    var winCfg = g.READER_FLAG_CONFIG || {};
    var locationObj = loc || (typeof window !== 'undefined' && window.location) || {};
    var dbUrl = '';
    var dbNamespace = '';

    if (cfg.dbUrl) {
      dbUrl = String(cfg.dbUrl).trim();
      dbNamespace = cfg.dbNamespace ? String(cfg.dbNamespace).trim() : '';
    } else if (winCfg.dbUrl) {
      dbUrl = String(winCfg.dbUrl).trim();
      dbNamespace = winCfg.dbNamespace ? String(winCfg.dbNamespace).trim() : '';
    } else if (g.FIREBASE_DB_URL) {
      dbUrl = String(g.FIREBASE_DB_URL).trim();
      dbNamespace = winCfg.dbNamespace ? String(winCfg.dbNamespace).trim() : '';
    } else if (isLocalHostname(locationObj.hostname)) {
      var search = String(locationObj.search || '');
      if (search) {
        var params = new URLSearchParams(search);
        var emuParam = params.get('emulator') || params.get('rtdb_emulator') || '';
        if (isLocalEmulatorUrl(emuParam)) {
          dbUrl = emuParam.trim();
          dbNamespace = (params.get('ns') || '').trim();
        }
      }
      if (!dbUrl) {
        var storedEmu = safeStorageGet(EMU_STORAGE_KEY) || '';
        if (isLocalEmulatorUrl(storedEmu)) {
          dbUrl = storedEmu.trim();
        }
      }
    }

    dbUrl = dbUrl.replace(/\/+$/, '');
    if (!dbNamespace && cfg.dbNamespace) dbNamespace = String(cfg.dbNamespace).trim();
    if (!dbNamespace && winCfg.dbNamespace) dbNamespace = String(winCfg.dbNamespace).trim();
    return { dbUrl: dbUrl, dbNamespace: dbNamespace };
  }

  function buildWriteUrl(dbConfig, pageId, suggestionId, idToken) {
    var base = String((dbConfig && dbConfig.dbUrl) || '').replace(/\/+$/, '');
    if (!base) return '';
    var path = '/redline_suggestions/' + encodeURIComponent(pageId) + '/' + encodeURIComponent(suggestionId) + '.json';
    var q = [];
    if (dbConfig && dbConfig.dbNamespace) {
      q.push('ns=' + encodeURIComponent(dbConfig.dbNamespace));
    }
    if (idToken) {
      q.push('auth=' + encodeURIComponent(idToken));
    }
    return base + path + (q.length ? ('?' + q.join('&')) : '');
  }

  function computeMenuPosition(x, y, w, h, vw, vh, margin) {
    var m = typeof margin === 'number' ? margin : 8;
    var left = x;
    var top = y;
    if (left + w > vw - m) left = x - w;
    if (top + h > vh - m) top = y - h;
    left = Math.max(m, Math.min(left, vw - w - m));
    top = Math.max(m, Math.min(top, vh - h - m));
    return { left: Math.round(left), top: Math.round(top) };
  }

  function isGoogleVerifiedSession(sess) {
    if (!sess || !sess.uid || !sess.idToken) return false;
    var prov = String(sess.provider || '').toLowerCase();
    if (prov !== 'google' && prov !== 'google.com') return false;
    if (sess.emailVerified !== true) return false;
    if (typeof sess.exp === 'number' && sess.exp > 0 && Date.now() > sess.exp) return false;
    return true;
  }

  function getAuthSession() {
    if (isGoogleVerifiedSession(state.memorySession)) {
      return state.memorySession;
    }
    var raw = safeStorageGet(AUTH_STORAGE_KEY);
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (isGoogleVerifiedSession(parsed)) {
          state.memorySession = parsed;
          return parsed;
        }
      } catch (e) {}
    }
    // Passive read-only fallback if AuthGate is already signed in with Google (never triggers requestAccess)
    var g = typeof window !== 'undefined' ? window : {};
    if (g.AuthGate && typeof g.AuthGate.getReviewerUid === 'function' && typeof g.AuthGate.getReviewerProvider === 'function') {
      var prov = g.AuthGate.getReviewerProvider();
      var uid = g.AuthGate.getReviewerUid();
      var tok = safeStorageGet('ih_firebase_auth_token');
      var exp = parseInt(safeStorageGet('ih_firebase_auth_token_exp') || '0', 10);
      if (prov === 'google.com' && uid && tok && (!exp || Date.now() < exp)) {
        return {
          uid: uid,
          email: typeof g.AuthGate.getReviewerEmail === 'function' ? g.AuthGate.getReviewerEmail() : '',
          displayName: typeof g.AuthGate.getReviewerName === 'function' ? g.AuthGate.getReviewerName() : '',
          emailVerified: true,
          provider: 'google.com',
          idToken: tok,
          exp: exp || 0
        };
      }
    }
    return null;
  }

  function setAuthSession(session) {
    if (!session || typeof session !== 'object') {
      clearAuthSession();
      return null;
    }
    var normalized = {
      uid: String(session.uid || '').trim(),
      email: String(session.email || '').trim().toLowerCase(),
      displayName: String(session.displayName || '').trim(),
      emailVerified: Boolean(session.emailVerified),
      provider: String(session.provider || '').trim(),
      idToken: String(session.idToken || '').trim(),
      exp: typeof session.exp === 'number' ? session.exp : 0
    };
    state.memorySession = normalized;
    safeStorageSet(AUTH_STORAGE_KEY, JSON.stringify(normalized));
    refreshAuthUi();
    return normalized;
  }

  function clearAuthSession() {
    state.memorySession = null;
    safeStorageRemove(AUTH_STORAGE_KEY);
    refreshAuthUi();
  }

  function configure(cfg) {
    state.config = Object.assign({}, state.config || {}, cfg || {});
    return resolveDbConfig(state.config);
  }

  function recordLocalFlag(entry) {
    try {
      var raw = safeStorageGet(SENT_STORAGE_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) arr = [];
      arr.unshift(entry);
      if (arr.length > 100) arr = arr.slice(0, 100);
      safeStorageSet(SENT_STORAGE_KEY, JSON.stringify(arr));
    } catch (e) {}
  }

  async function submitFlag(opts) {
    var session = getAuthSession();
    if (!isGoogleVerifiedSession(session)) {
      return { ok: false, error: 'יש להתחבר עם חשבון Google מאומת כדי לשלוח הצעת תיקון.' };
    }
    var dbCfg = resolveDbConfig(state.config);
    if (!dbCfg.dbUrl) {
      return { ok: false, error: 'כתובת מסד הנתונים (או emulator) אינה מוגדרת.' };
    }

    var built = buildSuggestionPayload(Object.assign({}, opts, {
      uid: session.uid,
      displayName: session.displayName || session.email || 'Reader'
    }));
    if (!built.ok) return built;

    var url = buildWriteUrl(dbCfg, built.pageId, built.suggestionId, session.idToken);
    var fetchFn = (state.config && state.config.fetch) || (typeof fetch === 'function' ? fetch : null);
    if (!fetchFn) {
      return { ok: false, error: 'Fetch API אינו זמין בסביבה זו.' };
    }

    try {
      var res = await fetchFn(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(built.payload)
      });
      if (!res.ok) {
        var detail = '';
        try {
          var body = await res.json();
          detail = (body && body.error) ? (': ' + body.error) : '';
        } catch (e) {}
        return { ok: false, error: 'השמירה נדחתה (HTTP ' + res.status + ')' + detail };
      }
      recordLocalFlag({
        id: built.suggestionId,
        pageId: built.pageId,
        lineId: built.payload.line_id,
        kind: built.payload.kind,
        createdAt: built.payload.created_at
      });
      return {
        ok: true,
        pageId: built.pageId,
        suggestionId: built.suggestionId,
        payload: built.payload
      };
    } catch (err) {
      return { ok: false, error: 'שגיאת רשת בשליחת ההצעה: ' + (err && err.message ? err.message : err) };
    }
  }

  async function signInWithGoogle() {
    if (state.config && typeof state.config.signIn === 'function') {
      try {
        var customSess = await state.config.signIn();
        if (!customSess || !isGoogleVerifiedSession(customSess)) {
          return { ok: false, error: 'נדרש חשבון Google עם דוא"ל מאומת.' };
        }
        setAuthSession(customSess);
        return { ok: true, session: getAuthSession() };
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : 'שגיאה בהתחברות' };
      }
    }

    var g = typeof window !== 'undefined' ? window : {};
    var fb = g.firebase;
    var fbConfig = (state.config && state.config.firebaseConfig) || g.FIREBASE_CONFIG;
    if (!fb || !fb.auth) {
      return { ok: false, error: 'חיבור Google אינו זמין ללא הגדרת Firebase Auth.' };
    }
    try {
      if (!fb.apps.length && fbConfig) {
        fb.initializeApp(fbConfig);
      }
      var auth = fb.auth();
      if (state.config && state.config.authEmulatorUrl && typeof auth.useEmulator === 'function') {
        auth.useEmulator(state.config.authEmulatorUrl);
      }
      var provider = new fb.auth.GoogleAuthProvider();
      if (typeof provider.setCustomParameters === 'function') {
        provider.setCustomParameters({ prompt: 'select_account' });
      }
      // Open popup directly inside click user-gesture without preceding awaits
      var result = await auth.signInWithPopup(provider);
      var user = result && result.user;
      if (!user || !user.emailVerified) {
        if (user && typeof auth.signOut === 'function') await auth.signOut();
        return { ok: false, error: 'חשבון ה-Google אינו מאומת.' };
      }
      var idToken = await user.getIdToken();
      var tokenRes = typeof user.getIdTokenResult === 'function' ? await user.getIdTokenResult() : null;
      var exp = tokenRes && tokenRes.expirationTime ? Date.parse(tokenRes.expirationTime) : (Date.now() + 3600000);
      setAuthSession({
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || (user.email ? user.email.split('@')[0] : 'Reader'),
        emailVerified: true,
        provider: 'google.com',
        idToken: idToken,
        exp: exp
      });
      return { ok: true, session: getAuthSession() };
    } catch (err) {
      return { ok: false, error: 'שגיאת התחברות Google: ' + (err && err.message ? err.message : err) };
    }
  }

  function signOut() {
    var g = typeof window !== 'undefined' ? window : {};
    try {
      if (g.firebase && g.firebase.auth && g.firebase.apps && g.firebase.apps.length) {
        g.firebase.auth().signOut();
      }
    } catch (e) {}
    clearAuthSession();
  }

  // ---- UI lookup & context normalization ----

  function findLineInPageData(pageData, lineId) {
    if (!pageData || !lineId) return null;
    var cleanId = normalizeLineId(lineId);
    if (!cleanId) return null;

    var paras = Array.isArray(pageData.paragraphs) ? pageData.paragraphs : [];
    for (var pi = 0; pi < paras.length; pi++) {
      var lines = Array.isArray(paras[pi].lines) ? paras[pi].lines : [];
      for (var li = 0; li < lines.length; li++) {
        if (normalizeLineId(lines[li].id) === cleanId) {
          return {
            lineId: cleanId,
            lineText: lines[li].t || '',
            paraPid: paras[pi].pid || null,
            paraIndex: pi,
            isFootnote: false
          };
        }
      }
    }

    var notes = Array.isArray(pageData.notes) ? pageData.notes : [];
    for (var ni = 0; ni < notes.length; ni++) {
      var nt = notes[ni];
      var nParas = Array.isArray(nt.paragraphs) ? nt.paragraphs : [];
      for (var npi = 0; npi < nParas.length; npi++) {
        var nLines = Array.isArray(nParas[npi].lines) ? nParas[npi].lines : [];
        for (var nli = 0; nli < nLines.length; nli++) {
          if (normalizeLineId(nLines[nli].id) === cleanId) {
            return {
              lineId: cleanId,
              lineText: nLines[nli].t || '',
              paraPid: nParas[npi].pid || null,
              paraIndex: npi <= 99 ? npi : null,
              isFootnote: true,
              noteId: normalizeLineId(nt.id) || cleanId,
              marker: nt.marker || ''
            };
          }
        }
      }
      if (normalizeLineId(nt.id) === cleanId) {
        return {
          lineId: cleanId,
          lineText: nt.t || '',
          paraIndex: ni <= 99 ? ni : null,
          isFootnote: true,
          noteId: cleanId,
          marker: nt.marker || ''
        };
      }
    }
    return null;
  }

  function parseParaIndex(paraPid, explicitIdx) {
    if (typeof explicitIdx === 'number' && isFinite(explicitIdx) && explicitIdx >= 0 && explicitIdx <= 99) {
      return Math.floor(explicitIdx);
    }
    if (typeof paraPid === 'string') {
      var m = /:(\d+)$/.exec(paraPid.trim());
      if (m) {
        var num = parseInt(m[1], 10);
        if (num >= 0 && num <= 99) return num;
      }
    }
    return null;
  }

  function resolveContextFromElement(targetEl) {
    if (!targetEl) return null;
    if (typeof state.getLineContext === 'function') {
      var fromHook = state.getLineContext(targetEl);
      if (fromHook && fromHook.lineId) return fromHook;
    }
    var rline = targetEl.closest ? targetEl.closest('.rline') : null;
    if (!rline) return null;
    var pageAttr = rline.getAttribute('data-page') || '';
    var pageId = normalizePageId(pageAttr);
    var lineId = normalizeLineId(rline.getAttribute('data-line-id'));
    var paraPid = rline.getAttribute('data-para') || '';
    var pageN = pageId ? parseInt(pageId.slice(5), 10) : null;
    var pageData = typeof state.getPageData === 'function' && (pageN || pageId)
      ? state.getPageData(pageN || pageId)
      : null;
    var found = findLineInPageData(pageData, lineId);
    return {
      pageId: pageId,
      pageN: pageN,
      paraPid: (found && found.paraPid) || paraPid,
      paraIndex: parseParaIndex((found && found.paraPid) || paraPid, found && found.paraIndex),
      lineId: lineId,
      lineText: (found && found.lineText) || domToMarkup(rline),
      isFootnote: Boolean(found && found.isFootnote) || rline.classList.contains('fn-line'),
      noteId: found && found.noteId ? found.noteId : null,
      marker: found && found.marker ? found.marker : ''
    };
  }

  function collectPageLineOptions(pageIdOrN) {
    if (typeof state.getPageData !== 'function') return [];
    var pageData = state.getPageData(pageIdOrN);
    if (!pageData) return [];
    var out = [];
    var paras = Array.isArray(pageData.paragraphs) ? pageData.paragraphs : [];
    for (var pi = 0; pi < paras.length; pi++) {
      var lines = Array.isArray(paras[pi].lines) ? paras[pi].lines : [];
      for (var li = 0; li < lines.length; li++) {
        var cid = normalizeLineId(lines[li].id);
        if (!cid) continue;
        out.push({
          pageId: normalizePageId(pageData.page || pageData.n),
          pageN: pageData.n || parseInt(normalizePageId(pageData.page).slice(5), 10),
          paraPid: paras[pi].pid || null,
          paraIndex: pi <= 99 ? pi : null,
          lineId: cid,
          lineText: lines[li].t || '',
          isFootnote: false,
          label: 'פסקה ' + (pi + 1) + ': ' + (lines[li].t || '').slice(0, 46)
        });
      }
    }
    var notes = Array.isArray(pageData.notes) ? pageData.notes : [];
    for (var ni = 0; ni < notes.length; ni++) {
      var nt = notes[ni];
      var nid = normalizeLineId(nt.id);
      var nParas = Array.isArray(nt.paragraphs) ? nt.paragraphs : [];
      if (nParas.length) {
        for (var npi = 0; npi < nParas.length; npi++) {
          var nLines = Array.isArray(nParas[npi].lines) ? nParas[npi].lines : [];
          for (var nli = 0; nli < nLines.length; nli++) {
            var nlid = normalizeLineId(nLines[nli].id);
            if (!nlid) continue;
            out.push({
              pageId: normalizePageId(pageData.page || pageData.n),
              pageN: pageData.n || parseInt(normalizePageId(pageData.page).slice(5), 10),
              paraPid: nParas[npi].pid || null,
              paraIndex: npi <= 99 ? npi : null,
              lineId: nlid,
              lineText: nLines[nli].t || '',
              isFootnote: true,
              noteId: nid || nlid,
              marker: nt.marker || '',
              label: 'הערה (' + (nt.marker || (ni + 1)) + '): ' + (nLines[nli].t || '').slice(0, 42)
            });
          }
        }
      } else if (nid) {
        out.push({
          pageId: normalizePageId(pageData.page || pageData.n),
          pageN: pageData.n || parseInt(normalizePageId(pageData.page).slice(5), 10),
          paraIndex: ni <= 99 ? ni : null,
          lineId: nid,
          lineText: nt.t || '',
          isFootnote: true,
          noteId: nid,
          marker: nt.marker || '',
          label: 'הערה (' + (nt.marker || (ni + 1)) + '): ' + (nt.t || '').slice(0, 42)
        });
      }
    }
    return out;
  }

  function normalizeTargetContext(ctx) {
    if (!ctx) {
      var sel = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
      if (sel && sel.rangeCount && state.streamEl) {
        var anchor = sel.anchorNode;
        var anchorEl = anchor && anchor.nodeType === 1 ? anchor : (anchor && anchor.parentElement);
        if (anchorEl && state.streamEl.contains(anchorEl)) {
          var fromSel = resolveContextFromElement(anchorEl);
          if (fromSel) return fromSel;
        }
      }
      var cur = typeof state.getCurrentPage === 'function' ? state.getCurrentPage() : 1;
      var pid = normalizePageId(cur) || 'page-01';
      var pNum = parseInt(pid.slice(5), 10);
      var opts = collectPageLineOptions(pNum);
      if (opts.length) {
        return Object.assign({}, opts[0], { pageOptions: opts });
      }
      return { pageId: pid, pageN: pNum, lineId: '', lineText: '', isFootnote: false, pageOptions: [] };
    }

    var pageId = normalizePageId(ctx.pageId || ctx.page || ctx.pageN);
    var pageN = ctx.pageN || (pageId ? parseInt(pageId.slice(5), 10) : null);
    var noteObj = ctx.note || null;
    var isFn = Boolean(ctx.isFootnote || noteObj);
    var lineId = normalizeLineId(ctx.lineId || (noteObj && noteObj.id));
    var lineText = ctx.lineText != null ? String(ctx.lineText) : '';
    var paraPid = ctx.paraPid || null;
    var paraIndex = ctx.paraIndex;

    if ((!lineText || paraIndex == null) && typeof state.getPageData === 'function' && (pageN || pageId)) {
      var pData = state.getPageData(pageN || pageId);
      var lookup = findLineInPageData(pData, lineId);
      if (lookup) {
        if (!lineText) lineText = lookup.lineText;
        if (paraPid == null && lookup.paraPid) paraPid = lookup.paraPid;
        if (paraIndex == null && lookup.paraIndex != null) paraIndex = lookup.paraIndex;
        if (lookup.isFootnote) isFn = true;
      }
    }

    if (!lineText && noteObj) {
      var nParas = Array.isArray(noteObj.paragraphs) ? noteObj.paragraphs : [];
      var firstPara = nParas.length ? nParas[0] : null;
      var firstLine = firstPara && Array.isArray(firstPara.lines) && firstPara.lines.length ? firstPara.lines[0] : null;
      if (firstLine && normalizeLineId(firstLine.id) === lineId && firstLine.t) {
        lineText = String(firstLine.t);
        if (paraPid == null && firstPara.pid) paraPid = firstPara.pid;
        if (paraIndex == null) paraIndex = 0;
      } else if (noteObj.t) {
        lineText = String(noteObj.t);
      }
    }

    return {
      pageId: pageId,
      pageN: pageN,
      paraPid: paraPid,
      paraIndex: parseParaIndex(paraPid, paraIndex),
      lineId: lineId || '',
      lineText: lineText,
      isFootnote: isFn,
      noteId: normalizeLineId(ctx.noteId || (noteObj && noteObj.id)) || null,
      marker: ctx.marker || (noteObj && noteObj.marker) || '',
      kind: ctx.kind || (isFn ? 'footnote' : 'word'),
      target: ctx.target || 'line',
      triggerEl: ctx.triggerEl || null,
      pageOptions: Array.isArray(ctx.pageOptions) ? ctx.pageOptions : null
    };
  }

  // ---- DOM construction & event wiring ----

  function setStatus(stateName, text) {
    var st = state.dom.statusEl;
    if (!st) return;
    if (!text) {
      st.hidden = true;
      st.textContent = '';
      delete st.dataset.state;
      return;
    }
    st.dataset.state = stateName || 'info';
    st.textContent = text;
    st.hidden = false;
  }

  function refreshAuthUi() {
    var sess = getAuthSession();
    var signedIn = isGoogleVerifiedSession(sess);
    if (state.dom.barBtn) {
      state.dom.barBtn.setAttribute('data-signed-in', signedIn ? 'true' : 'false');
    }
    if (!state.dom.authInfo) return;
    if (signedIn) {
      state.dom.authInfo.textContent = 'מחובר: ' + (sess.displayName || sess.email || sess.uid);
      if (state.dom.signInBtn) state.dom.signInBtn.hidden = true;
      if (state.dom.signOutBtn) state.dom.signOutBtn.hidden = false;
      if (state.dom.submitBtn) state.dom.submitBtn.disabled = false;
    } else {
      state.dom.authInfo.textContent = 'יש להתחבר עם Google כדי לשלוח הצעות תיקון (ללא דרישת הרשאת עורך).';
      if (state.dom.signInBtn) state.dom.signInBtn.hidden = false;
      if (state.dom.signOutBtn) state.dom.signOutBtn.hidden = true;
      if (state.dom.submitBtn) state.dom.submitBtn.disabled = true;
    }
  }

  function applyTargetToForm(t) {
    state.activeTarget = t;
    var dom = state.dom;
    if (!dom.modal) return;

    dom.pageChip.textContent = t.pageN ? ('עמוד ' + t.pageN) : (t.pageId || '');
    if (t.isFootnote && t.marker) {
      dom.lineChip.textContent = 'הערה (' + t.marker + ')';
    } else if (t.lineId) {
      dom.lineChip.textContent = 'שורה: ' + t.lineId;
    } else {
      dom.lineChip.textContent = 'בחר שורה';
    }

    if (t.pageOptions && t.pageOptions.length) {
      dom.lineSelectWrap.hidden = false;
      dom.lineSelect.textContent = '';
      t.pageOptions.forEach(function (opt, idx) {
        var o = el('option', null, opt.label);
        o.value = String(idx);
        if (opt.lineId === t.lineId) o.selected = true;
        dom.lineSelect.appendChild(o);
      });
    } else {
      dom.lineSelectWrap.hidden = true;
      dom.lineSelect.textContent = '';
    }

    dom.previewEl.textContent = '';
    if (t.lineText) {
      var previewText = t.lineText.length > 260 ? (t.lineText.slice(0, 260) + '…') : t.lineText;
      appendRich(dom.previewEl, previewText);
      dom.previewEl.hidden = false;
    } else {
      dom.previewEl.hidden = true;
    }

    dom.kindSelect.value = t.kind && VALID_KINDS.indexOf(t.kind) !== -1 ? t.kind : (t.isFootnote ? 'footnote' : 'word');
    dom.targetSelect.value = t.target && VALID_TARGETS.indexOf(t.target) !== -1 ? t.target : 'line';
    if (t.lineText && t.lineText.length <= 1000) {
      dom.proposedInput.value = t.lineText;
      dom.proposedInput.placeholder = '';
    } else {
      dom.proposedInput.value = '';
      dom.proposedInput.placeholder = t.lineText
        ? 'הקטע ארוך מ-1000 תווים — הזן כאן את התיקון המוצע בלבד'
        : 'הזן הצעת תיקון (אופציונלי)';
    }
    dom.noteInput.value = '';
    setStatus('', '');
    refreshAuthUi();
  }

  function buildUi() {
    if (typeof document === 'undefined') return;
    var mount = state.mountEl || document.body;

    // 1. Compact toolbar button
    if (state.barSlotEl && !state.dom.barBtn) {
      state.barSlotEl.textContent = '';
      var barBtn = el('button', 'btn icon flag-bar-btn');
      barBtn.id = 'readerFlagBarBtn';
      barBtn.type = 'button';
      var isEn = window.RYMH_LANG === 'en';
      barBtn.setAttribute('aria-label', isEn ? 'Suggest a text correction' : 'הצע תיקון לטקסט');
      barBtn.setAttribute('title', isEn ? 'Suggest a correction (Flag)' : 'הצע תיקון (Flag)');
      barBtn.appendChild(el('span', null, '⚑'));
      barBtn.appendChild(el('span', 'flag-bar-label', isEn ? 'Flag' : 'דיווח'));
      barBtn.addEventListener('click', function () {
        openForTarget(null, barBtn);
      });
      state.barSlotEl.appendChild(barBtn);
      state.dom.barBtn = barBtn;
    }

    if (state.dom.backdrop) return;

    // 2. Context menu
    var ctxMenu = el('div', 'flag-ctx-menu');
    ctxMenu.id = 'readerFlagCtxMenu';
    ctxMenu.setAttribute('role', 'menu');
    ctxMenu.setAttribute('aria-label', 'אפשרויות דיווח על שורה');
    ctxMenu.hidden = true;
    var ctxBtn = el('button', 'flag-ctx-item', '⚑ הצע תיקון בשורה זו');
    ctxBtn.id = 'readerFlagCtxBtn';
    ctxBtn.type = 'button';
    ctxBtn.setAttribute('role', 'menuitem');
    ctxBtn.addEventListener('click', function () {
      var savedCtx = state.ctxTarget;
      closeContextMenu();
      if (savedCtx) openForTarget(savedCtx, savedCtx.triggerEl || null);
    });
    ctxMenu.appendChild(ctxBtn);
    mount.appendChild(ctxMenu);

    // 3. Flag modal dialog
    var backdrop = el('div', 'flag-backdrop');
    backdrop.id = 'readerFlagBackdrop';
    backdrop.hidden = true;

    var modal = el('div', 'flag-modal');
    modal.id = 'readerFlagModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'readerFlagTitle');
    modal.setAttribute('dir', 'rtl');
    modal.hidden = true;

    var head = el('div', 'flag-modal-head');
    var title = el('h2', 'flag-modal-title', 'הצעת תיקון לטקסט');
    title.id = 'readerFlagTitle';
    var closeBtn = el('button', 'flag-close-btn', '✕');
    closeBtn.id = 'readerFlagCloseBtn';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'סגור חלון דיווח');
    closeBtn.addEventListener('click', function () { close(); });
    head.appendChild(title);
    head.appendChild(closeBtn);
    modal.appendChild(head);

    var body = el('div', 'flag-modal-body');

    var authBar = el('div', 'flag-auth-bar');
    var authInfo = el('span', 'flag-auth-info', '');
    authInfo.id = 'readerFlagAuthInfo';
    var authActions = el('div', null);
    var signInBtn = el('button', 'flag-signin-btn', 'התחבר עם Google');
    signInBtn.id = 'readerFlagSignInBtn';
    signInBtn.type = 'button';
    signInBtn.addEventListener('click', function () {
      signInBtn.disabled = true;
      setStatus('', '');
      // Call synchronously within click gesture for popup sign-in
      signInWithGoogle().then(function (res) {
        signInBtn.disabled = false;
        refreshAuthUi();
        if (!res.ok) setStatus('error', res.error || 'ההתחברות נכשלה');
      });
    });
    var signOutBtn = el('button', 'flag-signout-btn', 'התנתק');
    signOutBtn.id = 'readerFlagSignOutBtn';
    signOutBtn.type = 'button';
    signOutBtn.hidden = true;
    signOutBtn.addEventListener('click', function () { signOut(); });
    authActions.appendChild(signInBtn);
    authActions.appendChild(signOutBtn);
    authBar.appendChild(authInfo);
    authBar.appendChild(authActions);
    body.appendChild(authBar);

    var meta = el('div', 'flag-target-meta');
    var pageChip = el('span', 'flag-meta-chip', '');
    var lineChip = el('span', 'flag-meta-chip', '');
    meta.appendChild(pageChip);
    meta.appendChild(lineChip);
    body.appendChild(meta);

    var lineSelectWrap = el('div', 'flag-field');
    lineSelectWrap.hidden = true;
    var lineSelectLbl = el('label', null, 'בחירת שורה או הערה בעמוד');
    lineSelectLbl.setAttribute('for', 'readerFlagLineSelect');
    var lineSelect = el('select', null);
    lineSelect.id = 'readerFlagLineSelect';
    lineSelect.addEventListener('change', function () {
      if (!state.activeTarget || !state.activeTarget.pageOptions) return;
      var chosen = state.activeTarget.pageOptions[parseInt(lineSelect.value, 10)];
      if (chosen) {
        var next = Object.assign({}, chosen, { pageOptions: state.activeTarget.pageOptions });
        applyTargetToForm(next);
      }
    });
    lineSelectWrap.appendChild(lineSelectLbl);
    lineSelectWrap.appendChild(lineSelect);
    body.appendChild(lineSelectWrap);

    var previewEl = el('p', 'flag-preview');
    previewEl.id = 'readerFlagPreview';
    previewEl.setAttribute('dir', 'rtl');
    body.appendChild(previewEl);

    var form = el('form', 'flag-form');
    form.id = 'readerFlagForm';
    form.setAttribute('novalidate', 'novalidate');

    var row = el('div', 'flag-row');
    var kindWrap = el('div', 'flag-field');
    var kindLbl = el('label', null, 'סוג הדיווח');
    kindLbl.setAttribute('for', 'readerFlagKind');
    var kindSelect = el('select', null);
    kindSelect.id = 'readerFlagKind';
    [
      ['word', 'טעות במילה'],
      ['missing', 'מילה חסרה / מיותרת'],
      ['format', 'עיצוב / הדגשה (**…**)'],
      ['footnote', 'הערת שוליים'],
      ['translation', 'תרגום']
    ].forEach(function (pair) {
      var o = el('option', null, pair[1]);
      o.value = pair[0];
      kindSelect.appendChild(o);
    });
    kindWrap.appendChild(kindLbl);
    kindWrap.appendChild(kindSelect);

    var targetWrap = el('div', 'flag-field');
    var targetLbl = el('label', null, 'יעד');
    targetLbl.setAttribute('for', 'readerFlagTarget');
    var targetSelect = el('select', null);
    targetSelect.id = 'readerFlagTarget';
    [
      ['line', 'טקסט עברי / הערה'],
      ['translation', 'תרגום']
    ].forEach(function (pair) {
      var o = el('option', null, pair[1]);
      o.value = pair[0];
      targetSelect.appendChild(o);
    });
    targetWrap.appendChild(targetLbl);
    targetWrap.appendChild(targetSelect);

    row.appendChild(kindWrap);
    row.appendChild(targetWrap);
    form.appendChild(row);

    var propWrap = el('div', 'flag-field');
    var propHead = el('div', 'flag-field-head');
    var propLbl = el('label', null, 'הטקסט המוצע (שומר על סימוני **הדגשה**)');
    propLbl.setAttribute('for', 'readerFlagProposed');
    var boldBtn = el('button', 'flag-bold-btn', 'B הדגש **');
    boldBtn.id = 'readerFlagBoldBtn';
    boldBtn.type = 'button';
    boldBtn.setAttribute('aria-label', 'הוסף או הסר הדגשת **…**');
    boldBtn.addEventListener('click', function () {
      toggleBoldInTextarea(proposedInput);
    });
    propHead.appendChild(propLbl);
    propHead.appendChild(boldBtn);

    var proposedInput = el('textarea', null);
    proposedInput.id = 'readerFlagProposed';
    proposedInput.setAttribute('dir', 'rtl');
    proposedInput.maxLength = 1000;
    propWrap.appendChild(propHead);
    propWrap.appendChild(proposedInput);
    form.appendChild(propWrap);

    var noteWrap = el('div', 'flag-field');
    var noteLbl = el('label', null, 'הערה / הסבר (אופציונלי)');
    noteLbl.setAttribute('for', 'readerFlagNote');
    var noteInput = el('textarea', null);
    noteInput.id = 'readerFlagNote';
    noteInput.setAttribute('dir', 'rtl');
    noteInput.maxLength = 1000;
    noteWrap.appendChild(noteLbl);
    noteWrap.appendChild(noteInput);
    form.appendChild(noteWrap);

    var statusEl = el('div', 'flag-status', '');
    statusEl.id = 'readerFlagStatus';
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');
    statusEl.hidden = true;
    form.appendChild(statusEl);

    var actions = el('div', 'flag-actions');
    var cancelBtn = el('button', 'flag-cancel-btn', 'ביטול');
    cancelBtn.id = 'readerFlagCancelBtn';
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', function () { close(); });

    var submitBtn = el('button', 'flag-submit-btn', 'שלח הצעה');
    submitBtn.id = 'readerFlagSubmitBtn';
    submitBtn.type = 'submit';
    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);
    form.appendChild(actions);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!state.activeTarget) return;
      submitBtn.disabled = true;
      setStatus('info', 'שולח הצעה…');
      submitFlag({
        pageId: state.activeTarget.pageId,
        lineId: state.activeTarget.lineId,
        kind: kindSelect.value,
        target: targetSelect.value,
        para: state.activeTarget.paraIndex,
        proposedText: proposedInput.value,
        note: noteInput.value
      }).then(function (res) {
        refreshAuthUi();
        if (res.ok) {
          setStatus('success', 'ההצעה נשלחה בהצלחה ותיבדק על ידי העורך.');
        } else {
          setStatus('error', res.error || 'השליחה נכשלה');
        }
      });
    });

    body.appendChild(form);
    modal.appendChild(body);
    backdrop.appendChild(modal);
    mount.appendChild(backdrop);

    backdrop.addEventListener('click', function (ev) {
      if (ev.target === backdrop) close();
    });

    state.dom.ctxMenu = ctxMenu;
    state.dom.ctxBtn = ctxBtn;
    state.dom.backdrop = backdrop;
    state.dom.modal = modal;
    state.dom.closeBtn = closeBtn;
    state.dom.authInfo = authInfo;
    state.dom.signInBtn = signInBtn;
    state.dom.signOutBtn = signOutBtn;
    state.dom.pageChip = pageChip;
    state.dom.lineChip = lineChip;
    state.dom.lineSelectWrap = lineSelectWrap;
    state.dom.lineSelect = lineSelect;
    state.dom.previewEl = previewEl;
    state.dom.kindSelect = kindSelect;
    state.dom.targetSelect = targetSelect;
    state.dom.proposedInput = proposedInput;
    state.dom.noteInput = noteInput;
    state.dom.statusEl = statusEl;
    state.dom.submitBtn = submitBtn;

    refreshAuthUi();
  }

  function openContextMenu(x, y, ctx) {
    if (!state.dom.ctxMenu) return;
    state.ctxTarget = ctx;
    var menu = state.dom.ctxMenu;
    menu.hidden = false;
    var rect = menu.getBoundingClientRect ? menu.getBoundingClientRect() : { width: 200, height: 48 };
    var pos = computeMenuPosition(
      x,
      y,
      rect.width || 200,
      rect.height || 48,
      window.innerWidth || 800,
      window.innerHeight || 600,
      8
    );
    menu.style.left = pos.left + 'px';
    menu.style.top = pos.top + 'px';
    if (state.dom.ctxBtn && typeof state.dom.ctxBtn.focus === 'function') {
      state.dom.ctxBtn.focus();
    }
  }

  function closeContextMenu() {
    if (!state.dom.ctxMenu || state.dom.ctxMenu.hidden) return;
    state.dom.ctxMenu.hidden = true;
    state.ctxTarget = null;
  }

  function setBackgroundInert(flag) {
    var target = state.inertEl;
    if (!target) return;
    if ('inert' in target) {
      target.inert = flag;
    }
    if (flag) {
      target.setAttribute('aria-hidden', 'true');
    } else {
      target.removeAttribute('aria-hidden');
    }
  }

  function openForTarget(ctx, fallbackTrigger) {
    if (typeof document !== 'undefined' && !state.dom.modal) buildUi();
    closeContextMenu();
    var normalized = normalizeTargetContext(ctx);
    state.triggerEl = normalized.triggerEl || fallbackTrigger || (typeof document !== 'undefined' ? document.activeElement : null);
    applyTargetToForm(normalized);
    if (state.dom.backdrop && state.dom.modal) {
      setBackgroundInert(true);
      state.dom.backdrop.hidden = false;
      state.dom.modal.hidden = false;
      if (state.dom.closeBtn && typeof state.dom.closeBtn.focus === 'function') {
        state.dom.closeBtn.focus();
      }
    }
  }

  function close() {
    closeContextMenu();
    if (!state.dom.backdrop || state.dom.backdrop.hidden) return;
    state.dom.modal.hidden = true;
    state.dom.backdrop.hidden = true;
    setBackgroundInert(false);
    var prev = state.triggerEl;
    state.triggerEl = null;
    state.activeTarget = null;
    if (prev && prev.isConnected !== false && typeof prev.focus === 'function') {
      prev.focus();
    }
  }

  function isOpen() {
    return Boolean(state.dom.backdrop && !state.dom.backdrop.hidden);
  }

  function bindGlobalEvents() {
    if (state.initialized || typeof document === 'undefined') return;
    state.initialized = true;

    if (state.streamEl) {
      state.streamEl.addEventListener('contextmenu', function (ev) {
        if (ev.shiftKey) return;
        var ctx = resolveContextFromElement(ev.target);
        if (!ctx || !ctx.lineId) return;
        ev.preventDefault();
        ctx.triggerEl = ev.target && ev.target.closest ? ev.target.closest('.rline') : ev.target;
        openContextMenu(ev.clientX, ev.clientY, ctx);
      });

      state.streamEl.addEventListener('keydown', function (ev) {
        if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) {
          var ctx = resolveContextFromElement(document.activeElement);
          if (!ctx || !ctx.lineId) return;
          ev.preventDefault();
          var rline = document.activeElement.closest ? document.activeElement.closest('.rline') : document.activeElement;
          var r = rline && rline.getBoundingClientRect ? rline.getBoundingClientRect() : { left: 24, bottom: 24 };
          ctx.triggerEl = rline;
          openContextMenu(r.left, r.bottom + 4, ctx);
        }
      });
    }

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        if (isOpen()) {
          ev.preventDefault();
          close();
        } else if (state.dom.ctxMenu && !state.dom.ctxMenu.hidden) {
          ev.preventDefault();
          var ret = state.ctxTarget && state.ctxTarget.triggerEl;
          closeContextMenu();
          if (ret && ret.isConnected !== false && typeof ret.focus === 'function') ret.focus();
        }
      } else if (ev.key === 'Tab' && isOpen() && state.dom.modal) {
        var focusables = Array.prototype.filter.call(
          state.dom.modal.querySelectorAll('button, select, textarea, input'),
          function (node) {
            return !node.disabled && !node.hidden && node.offsetParent !== null;
          }
        );
        if (focusables.length) {
          var first = focusables[0];
          var last = focusables[focusables.length - 1];
          if (ev.shiftKey && document.activeElement === first) {
            ev.preventDefault();
            last.focus();
          } else if (!ev.shiftKey && document.activeElement === last) {
            ev.preventDefault();
            first.focus();
          }
        }
      }
    });

    document.addEventListener('pointerdown', function (ev) {
      if (state.dom.ctxMenu && !state.dom.ctxMenu.hidden && !state.dom.ctxMenu.contains(ev.target)) {
        closeContextMenu();
      }
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('scroll', closeContextMenu, { capture: true, passive: true });
      window.addEventListener('resize', closeContextMenu, { passive: true });
    }
  }

  function init(opts) {
    var o = opts || {};
    state.mountEl = o.mountEl || (typeof document !== 'undefined' ? document.body : null);
    state.barSlotEl = o.barSlotEl || null;
    state.streamEl = o.streamEl || null;
    state.inertEl = o.inertEl || null;
    state.getPageData = typeof o.getPageData === 'function' ? o.getPageData : null;
    state.getCurrentPage = typeof o.getCurrentPage === 'function' ? o.getCurrentPage : null;
    state.getLineContext = typeof o.getLineContext === 'function' ? o.getLineContext : null;
    state.config = Object.assign({}, o.config || (typeof window !== 'undefined' && window.READER_FLAG_CONFIG) || {});
    buildUi();
    bindGlobalEvents();
    return api;
  }

  var api = {
    init: init,
    configure: configure,
    openForTarget: openForTarget,
    close: close,
    isOpen: isOpen,
    submitFlag: submitFlag,
    signInWithGoogle: signInWithGoogle,
    signOut: signOut,
    setAuthSession: setAuthSession,
    getAuthSession: getAuthSession,
    clearAuthSession: clearAuthSession,
    makeSuggestionId: makeSuggestionId,
    normalizePageId: normalizePageId,
    normalizeLineId: normalizeLineId,
    domToMarkup: domToMarkup,
    toggleBoldInTextarea: toggleBoldInTextarea,
    buildSuggestionPayload: buildSuggestionPayload,
    resolveDbConfig: resolveDbConfig,
    buildWriteUrl: buildWriteUrl,
    computeMenuPosition: computeMenuPosition
  };

  if (typeof window !== 'undefined') {
    window.ReaderFlag = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
