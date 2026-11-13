/**
 * auth_gate.js
 *
 * Full-Site Security Gate: Enforces Google Sign-In with Chief Editor Approval
 * before rendering or accessing the dashboard, review workspace, or editor.
 *
 * - 1-Click "Sign in with Google" as primary authentication flow.
 * - Automatic approval check against /approved_reviewers (or Chief Editor rhabbaz@gmail.com).
 * - Automatic recording of access requests to /access_requests/$uid for pending review.
 * - Clean "Pending Approval from Chief Editor" interface for unapproved accounts.
 * - Google is the only sign-in method.
 * - Server-side verification via Google Identity Platform & Secure Token Service.
 */

window.AuthGate = (function() {
  const EMAIL_STORAGE_KEY = 'ih_reviewer_email';
  const NAME_STORAGE_KEY = 'ih_reviewer_name';
  const TOKEN_STORAGE_KEY = 'ih_firebase_auth_token';
  const REFRESH_TOKEN_KEY = 'ih_firebase_refresh_token';
  const TOKEN_EXPIRY_KEY = 'ih_firebase_auth_token_exp';
  const PASSCODE_STORAGE_KEY = 'ih_reviewer_passcode';
  const UID_STORAGE_KEY = 'ih_reviewer_uid';
  const PHOTO_STORAGE_KEY = 'ih_reviewer_photo';
  const PROVIDER_STORAGE_KEY = 'ih_reviewer_provider';
  const APPROVAL_STATUS_KEY = 'ih_reviewer_approval_status';

  const MASTER_EMAIL = 'rhabbaz@gmail.com';
  const PHRASE_STORAGE_KEY = 'ih_signup_phrase_hash';
  const PHRASE_HASH = 'b849db1dfa3ddaaba6da17bdc618bf5beb0ebd65272be51b18f38c83e69b0a25';

  // Optional "secret phrase" easter egg at first sign-up. Only a SHA-256 of the normalized phrase
  // is ever stored or sent; it grants no access and only flags the request for the Chief Editor.
  async function hashPhrase(phrase) {
    const normalized = String(phrase || '').replace(/\s+/g, '').toLowerCase();
    if (!normalized || !(window.crypto && window.crypto.subtle)) return '';
    const bytes = new TextEncoder().encode(normalized);
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const CONFIG = (typeof window !== 'undefined' && window.FIREBASE_CONFIG) || {
    apiKey: 'AIzaSyBmFOK7Iej8WHSaWyO2RxARVaxrdhdqJds',
    authDomain: 'iyye-hayyam.firebaseapp.com',
    projectId: 'iyye-hayyam'
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function safePhotoUrl(url) {
    return /^https:\/\//i.test(url || '') ? url : '';
  }

  function getApiKey() {
    return (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey) || CONFIG.apiKey;
  }

  function getDbBaseUrl() {
    return (typeof window !== 'undefined' && window.FIREBASE_DB_URL)
      ? window.FIREBASE_DB_URL
      : (typeof window !== 'undefined' && window.location && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'))
        ? window.location.origin
        : 'https://iyye-hayyam-default-rtdb.firebaseio.com';
  }

  function getReviewerEmail() {
    return (localStorage.getItem(EMAIL_STORAGE_KEY) || '').trim().toLowerCase();
  }

  function getReviewerUid() {
    let uid = localStorage.getItem(UID_STORAGE_KEY) || '';
    if (!uid && getReviewerEmail()) {
      uid = 'user_' + getReviewerEmail().replace(/[^a-zA-Z0-9]/g, '_');
    }
    return uid;
  }

  function getReviewerName() {
    const full = localStorage.getItem(NAME_STORAGE_KEY) || '';
    if (full.trim()) return full.trim();
    const email = getReviewerEmail();
    if (!email) return 'Reviewer';
    const namePart = email.split('@')[0].replace(/[._-]/g, ' ');
    return namePart.charAt(0).toUpperCase() + namePart.slice(1);
  }

  function getReviewerPhoto() {
    return localStorage.getItem(PHOTO_STORAGE_KEY) || '';
  }

  function getReviewerProvider() {
    return localStorage.getItem(PROVIDER_STORAGE_KEY) || 'password';
  }

  function getReviewerFirstName() {
    const parts = getReviewerName().split(' ');
    return parts[0] || '';
  }

  function getReviewerLastName() {
    const parts = getReviewerName().split(' ');
    return parts.slice(1).join(' ') || '';
  }

  function isApproved() {
    const email = getReviewerEmail();
    if (!email) return false;
    if (email === MASTER_EMAIL.toLowerCase()) return true;

    // Convenience cache only: the database rules are the real enforcement, and
    // verifyApprovalWithServer() refreshes this on every page load.
    return localStorage.getItem(APPROVAL_STATUS_KEY) === 'approved';
  }

  function getReviewerPasscode() {
    return isAuthorized() ? 'VERIFIED' : '';
  }

  function setReviewerPasscode() {
    // Retained for contract compatibility
  }

  function promptPasscode() {
    return isAuthorized();
  }

  function checkPasscodeOrPrompt() {
    if (isAuthorized()) return true;
    enforceFullSiteGate();
    return false;
  }

  function isAuthorized() {
    const token = localStorage.getItem(TOKEN_STORAGE_KEY);
    const email = getReviewerEmail();
    const refresh = localStorage.getItem(REFRESH_TOKEN_KEY);
    return !!(email && (token || refresh) && isApproved());
  }

  function isMasterEditor() {
    return isAuthorized() && (getReviewerEmail() === MASTER_EMAIL.toLowerCase());
  }

  function verifyMasterPassword(promptMsg) {
    if (isMasterEditor()) return true;

    const email = getReviewerEmail();
    alert(`Access restricted exclusively to Chief Editor (${MASTER_EMAIL}). Your current login is: ${email || 'none'}. Please sign out and log in with your Chief Editor credentials.`);
    return false;
  }

  async function ensureAuthToken() {
    const now = Date.now();
    const cachedToken = localStorage.getItem(TOKEN_STORAGE_KEY);
    const cachedExp = parseInt(localStorage.getItem(TOKEN_EXPIRY_KEY) || '0', 10);
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);

    // If cached token has > 5 minutes validity remaining, reuse it
    if (cachedToken && cachedExp > (now + 300000)) {
      return cachedToken;
    }

    const apiKey = getApiKey();
    if (!apiKey) return cachedToken || null;

    // If token expired or near expiry, refresh using refresh token
    if (refreshToken) {
      try {
        const refreshUrl = `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`;
        const res = await fetch(refreshUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
        });

        if (res.ok) {
          const data = await res.json();
          if (data && data.id_token) {
            const expiresInSec = parseInt(data.expires_in || '3600', 10);
            localStorage.setItem(TOKEN_STORAGE_KEY, data.id_token);
            localStorage.setItem(REFRESH_TOKEN_KEY, data.refresh_token || refreshToken);
            localStorage.setItem(TOKEN_EXPIRY_KEY, String(now + expiresInSec * 1000));
            return data.id_token;
          }
        }
      } catch (err) {
        console.warn('[AuthGate] Token refresh failed:', err);
      }
    }

    return cachedToken || null;
  }

  async function checkReviewerApproval(uid, email, token) {
    const cleanEmail = (email || getReviewerEmail()).toLowerCase();
    if (cleanEmail === MASTER_EMAIL.toLowerCase()) {
      localStorage.setItem(APPROVAL_STATUS_KEY, 'approved');
      return { approved: true, status: 'approved' };
    }

    const targetUid = uid || getReviewerUid();
    const dbUrl = getDbBaseUrl();
    const authToken = token || await ensureAuthToken();

    let reachable = false;
    try {
      const authParam = authToken ? `?auth=${encodeURIComponent(authToken)}` : '';

      // 1. Check approved_reviewers/$uid
      const approvedRes = await fetch(`${dbUrl}/approved_reviewers/${encodeURIComponent(targetUid)}.json${authParam}`);
      reachable = approvedRes.ok;
      if (approvedRes.ok) {
        const approvedVal = await approvedRes.json();
        if (approvedVal === true || (approvedVal && approvedVal.approved === true)) {
          localStorage.setItem(APPROVAL_STATUS_KEY, 'approved');
          return { approved: true, status: 'approved' };
        }
      }

      // 2. Check access_requests/$uid
      const requestRes = await fetch(`${dbUrl}/access_requests/${encodeURIComponent(targetUid)}.json${authParam}`);
      if (requestRes.ok) {
        const reqData = await requestRes.json();
        // 'approved' here is never trusted: only /approved_reviewers (writable by the Chief Editor alone) grants access.
        if (reqData && reqData.status === 'rejected') {
          localStorage.setItem(APPROVAL_STATUS_KEY, 'rejected');
          return { approved: false, status: 'rejected' };
        } else if (reqData && reqData.status === 'revoked') {
          localStorage.setItem(APPROVAL_STATUS_KEY, 'revoked');
          return { approved: false, status: 'revoked' };
        } else if (reqData && reqData.status === 'pending') {
          localStorage.setItem(APPROVAL_STATUS_KEY, 'pending');
          return { approved: false, status: 'pending' };
        }
      }
    } catch (err) {
      console.warn('[AuthGate] checkReviewerApproval error:', err);
    }

    // Server answered and did not list the user: never trust a cached 'approved'.
    // If the server was unreachable (offline), keep the cache; the rules still gate every read and write.
    const cached = localStorage.getItem(APPROVAL_STATUS_KEY);
    if (!reachable && cached === 'approved') return { approved: true, status: 'approved' };
    const status = (cached === 'rejected' || cached === 'revoked') ? cached : 'pending';
    localStorage.setItem(APPROVAL_STATUS_KEY, status);
    return { approved: false, status };
  }

  async function requestAccess(profile, token) {
    const dbUrl = getDbBaseUrl();
    const authToken = token || await ensureAuthToken();
    const uid = profile.uid || getReviewerUid();
    const email = (profile.email || getReviewerEmail()).toLowerCase();
    const displayName = profile.displayName || getReviewerName();
    const photoURL = profile.photoURL || getReviewerPhoto();

    const payload = {
      uid: uid,
      email: email,
      displayName: displayName,
      photoURL: photoURL,
      requested_at: new Date().toISOString(),
      status: 'pending'
    };
    const phraseHash = sessionStorage.getItem(PHRASE_STORAGE_KEY) || '';
    if (/^[0-9a-f]{64}$/.test(phraseHash)) payload.phrase_hash = phraseHash;

    try {
      const authParam = authToken ? `?auth=${encodeURIComponent(authToken)}` : '';
      await fetch(`${dbUrl}/access_requests/${encodeURIComponent(uid)}.json${authParam}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      localStorage.setItem(APPROVAL_STATUS_KEY, 'pending');
    } catch (err) {
      console.warn('[AuthGate] requestAccess error:', err);
    }
    return payload;
  }

  const FIREBASE_SDK_VERSION = '10.12.2';
  let firebaseSdkPromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(el);
    });
  }

  function loadFirebaseAuthSdk() {
    if (window.firebase && window.firebase.auth) return Promise.resolve(window.firebase);
    if (!firebaseSdkPromise) {
      const base = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;
      firebaseSdkPromise = loadScript(`${base}/firebase-app-compat.js`)
        .then(() => loadScript(`${base}/firebase-auth-compat.js`))
        .then(() => {
          if (!window.firebase.apps.length) window.firebase.initializeApp(getFirebaseConfig());
          return window.firebase;
        })
        .catch(err => { firebaseSdkPromise = null; throw err; });
    }
    return firebaseSdkPromise;
  }

  function getFirebaseConfig() {
    return Object.assign({}, CONFIG, window.FIREBASE_CONFIG || {});
  }

  async function signInWithGoogle() {
    try {
      // Use the already-loaded SDK synchronously so the popup opens within the click's user gesture.
      const firebase = (window.firebase && window.firebase.auth && window.firebase.apps.length)
        ? window.firebase
        : await loadFirebaseAuthSdk();
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });

      let result;
      try {
        result = await firebase.auth().signInWithPopup(provider);
      } catch (err) {
        if (err && (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request')) {
          return { success: false, error: 'Google sign-in was cancelled.' };
        }
        if (err && err.code === 'auth/popup-blocked') {
          return { success: false, error: 'Your browser blocked the Google sign-in popup. Allow popups for this site and try again.' };
        }
        if (err && err.code === 'auth/unauthorized-domain') {
          return { success: false, error: 'This site is not on the Firebase authorized-domains list yet.' };
        }
        if (err && err.code === 'auth/operation-not-allowed') {
          return { success: false, error: 'Google sign-in is not enabled for this project yet.' };
        }
        throw err;
      }

      const user = result && result.user;
      if (!user || !user.email) {
        return { success: false, error: 'Could not obtain Google authentication credentials.' };
      }

      const cleanEmail = user.email.trim().toLowerCase();
      if (!user.emailVerified) {
        await firebase.auth().signOut();
        return { success: false, error: 'Your Google account email is not verified.' };
      }

      // Firebase-issued ID token: the database rules verify it, and so can anyone else.
      const idToken = await user.getIdToken();
      const tokenResult = await user.getIdTokenResult();
      const expiresAt = Date.parse(tokenResult.expirationTime) || (Date.now() + 3600000);
      const displayName = user.displayName || cleanEmail.split('@')[0];

      localStorage.setItem(TOKEN_STORAGE_KEY, idToken);
      localStorage.setItem(REFRESH_TOKEN_KEY, user.refreshToken || '');
      localStorage.setItem(TOKEN_EXPIRY_KEY, String(expiresAt));
      localStorage.setItem(EMAIL_STORAGE_KEY, cleanEmail);
      localStorage.setItem(UID_STORAGE_KEY, user.uid);
      localStorage.setItem(NAME_STORAGE_KEY, displayName);
      localStorage.setItem(PHOTO_STORAGE_KEY, user.photoURL || '');
      localStorage.setItem(PROVIDER_STORAGE_KEY, 'google.com');

      if (cleanEmail === MASTER_EMAIL.toLowerCase()) {
        localStorage.setItem(APPROVAL_STATUS_KEY, 'approved');
        localStorage.setItem(PASSCODE_STORAGE_KEY, 'VERIFIED');
        await sendLoginAlert(cleanEmail);
        return { success: true, approved: true, email: cleanEmail, isMaster: true };
      }

      const approval = await checkReviewerApproval(user.uid, cleanEmail, idToken);
      if (approval.approved) {
        localStorage.setItem(APPROVAL_STATUS_KEY, 'approved');
        localStorage.setItem(PASSCODE_STORAGE_KEY, 'VERIFIED');
        await sendLoginAlert(cleanEmail);
        return { success: true, approved: true, email: cleanEmail, isMaster: false };
      }

      if (approval.status !== 'rejected' && approval.status !== 'revoked') {
        await requestAccess({
          uid: user.uid,
          email: cleanEmail,
          displayName: displayName,
          photoURL: user.photoURL || ''
        }, idToken);
      }

      return { success: true, approved: false, status: approval.status || 'pending', email: cleanEmail };

    } catch (err) {
      console.error('[AuthGate] Google sign-in exception:', err);
      return { success: false, error: 'Error during Google sign-in flow: ' + (err.message || err) };
    }
  }

  async function sendLoginAlert(email) {
    try {
      const dbUrl = getDbBaseUrl();
      const token = await ensureAuthToken();
      if (!token) return;

      const payload = {
        email: email,
        timestamp: new Date().toISOString(),
        user_agent: (typeof navigator !== 'undefined' && navigator.userAgent) || 'Unknown'
      };

      await fetch(`${dbUrl}/login_alerts.json?auth=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      });
    } catch (err) {
      console.warn('[AuthGate] Login alert record note:', err);
    }
  }

  function signOut() {
    try { if (window.firebase && window.firebase.auth) window.firebase.auth().signOut(); } catch (e) { /* ignore */ }
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXPIRY_KEY);
    localStorage.removeItem(EMAIL_STORAGE_KEY);
    localStorage.removeItem(NAME_STORAGE_KEY);
    localStorage.removeItem(PASSCODE_STORAGE_KEY);
    localStorage.removeItem(UID_STORAGE_KEY);
    localStorage.removeItem(PHOTO_STORAGE_KEY);
    localStorage.removeItem(PROVIDER_STORAGE_KEY);
    localStorage.removeItem(APPROVAL_STATUS_KEY);
    sessionStorage.clear();
    window.location.reload();
  }

  function enforceFullSiteGate() {
    if (isAuthorized()) {
      const existingOverlay = document.getElementById('fullSiteGateOverlay');
      if (existingOverlay) existingOverlay.remove();
      return true;
    }

    let overlay = document.getElementById('fullSiteGateOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'fullSiteGateOverlay';
      overlay.style.cssText = `
        position: fixed;
        inset: 0;
        z-index: 999999;
        background: #0f172a;
        color: #f8fafc;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        padding: 20px;
        direction: ltr;
      `;
      document.body.appendChild(overlay);
    }

    const email = getReviewerEmail();
    const token = localStorage.getItem(TOKEN_STORAGE_KEY);
    const approvalStatus = localStorage.getItem(APPROVAL_STATUS_KEY);

    // If user has signed in, but is pending approval or rejected
    if (email && token && !isApproved()) {
      renderPendingApprovalUI(overlay, email, approvalStatus);
      return false;
    }

    // Default: User not signed in -> render Google primary sign-in with fallback
    renderSignInUI(overlay);
    return false;
  }

  function renderPendingApprovalUI(overlay, email, status) {
    const isRejected = (status === 'rejected' || status === 'revoked');
    const name = escapeHtml(getReviewerName());
    const photo = safePhotoUrl(getReviewerPhoto());
    email = escapeHtml(email);

    overlay.innerHTML = `
      <div style="background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 36px 32px; max-width: 440px; width: 100%; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.6); text-align: center;">
        <div style="font-size: 44px; margin-bottom: 12px;">${isRejected ? '🚫' : '⏳'}</div>
        <h2 style="font-size: 20px; font-weight: 700; margin-bottom: 8px; color: #f8fafc;">
          ${isRejected ? 'Access Request Declined' : 'Pending Approval from Chief Editor'}
        </h2>

        <div style="margin: 16px 0; padding: 12px; background: #0f172a; border: 1px solid #334155; border-radius: 8px; display: flex; align-items: center; gap: 12px; text-align: left;">
          ${photo ? `<img src="${escapeHtml(photo)}" alt="Avatar" style="width: 40px; height: 40px; border-radius: 50%; border: 1px solid #475569;">` : `<div style="width: 40px; height: 40px; border-radius: 50%; background: #0284c7; color: #fff; font-weight: bold; display: flex; align-items: center; justify-content: center; font-size: 16px;">${escapeHtml(getReviewerName().charAt(0).toUpperCase())}</div>`}
          <div style="overflow: hidden;">
            <div style="font-weight: 600; color: #f1f5f9; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; overflow: hidden;">${name}</div>
            <div style="font-size: 12px; color: #94a3b8; text-overflow: ellipsis; white-space: nowrap; overflow: hidden;">${email}</div>
          </div>
        </div>

        <p style="font-size: 13px; color: #94a3b8; margin-bottom: 24px; line-height: 1.5; text-align: left;">
          ${isRejected
            ? `Your request for reviewer access has been declined by the Chief Editor. If you believe this is an error, please reach out to <a href="mailto:${MASTER_EMAIL}" style="color: #38bdf8;">${MASTER_EMAIL}</a>.`
            : `Your Google account has been verified, and your request for scholarly reviewer access has been recorded. Chief Editor Ray Habbaz (<a href="mailto:${MASTER_EMAIL}" style="color: #38bdf8; text-decoration: none;">${MASTER_EMAIL}</a>) reviews all incoming reviewer requests. Once approved, you will have immediate access to review folios.`}
        </p>

        ${(!isRejected && sessionStorage.getItem(PHRASE_STORAGE_KEY) === PHRASE_HASH) ? '<div dir="rtl" style="text-align: center; font-size: 20px; color: #fbbf24; margin-bottom: 16px;">יעבדוך עמים</div>' : ''}

        <div id="pendingStatusBadge" style="display: inline-block; padding: 6px 14px; border-radius: 999px; font-size: 12px; font-weight: 600; margin-bottom: 24px; ${isRejected ? 'background: rgba(239,68,68,0.2); color: #f87171; border: 1px solid #ef4444;' : 'background: rgba(245,158,11,0.2); color: #fbbf24; border: 1px solid #f59e0b;'}">
          ${isRejected ? 'Status: Declined' : 'Status: Under Review'}
        </div>

        <div style="display: flex; flex-direction: column; gap: 10px;">
          ${!isRejected ? `
            <button id="btnCheckApprovalStatus" style="width: 100%; padding: 12px; background: #0284c7; color: #fff; font-weight: 600; font-size: 14px; border: none; border-radius: 8px; cursor: pointer; transition: background 0.2s;">
              🔄 Check Approval Status
            </button>
          ` : ''}
          <button id="btnGateSignOut" style="width: 100%; padding: 10px; background: transparent; color: #94a3b8; font-size: 13px; border: 1px solid #475569; border-radius: 8px; cursor: pointer;">
            Sign Out
          </button>
        </div>
      </div>
    `;

    const btnCheck = document.getElementById('btnCheckApprovalStatus');
    if (btnCheck) {
      btnCheck.addEventListener('click', async () => {
        btnCheck.disabled = true;
        btnCheck.textContent = 'Checking status with server...';
        const result = await checkReviewerApproval();
        if (result.approved) {
          btnCheck.textContent = 'Approved! Loading...';
          overlay.remove();
          window.location.reload();
        } else {
          btnCheck.disabled = false;
          btnCheck.textContent = '🔄 Still Pending — Re-check';
          const badge = document.getElementById('pendingStatusBadge');
          if (badge && result.status === 'rejected') {
            badge.textContent = 'Status: Declined';
            badge.style.background = 'rgba(239,68,68,0.2)';
            badge.style.color = '#f87171';
            badge.style.borderColor = '#ef4444';
          }
        }
      });
    }

    const btnSignOut = document.getElementById('btnGateSignOut');
    if (btnSignOut) {
      btnSignOut.addEventListener('click', () => {
        signOut();
      });
    }
  }

  function renderSignInUI(overlay) {
    overlay.innerHTML = `
      <div style="background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 34px 30px; max-width: 420px; width: 100%; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.6); text-align: center;">
        <div style="font-size: 38px; margin-bottom: 12px;">🔒</div>
        <h2 style="font-size: 20px; font-weight: 700; margin-bottom: 6px; color: #f8fafc;">Iyye Hayyam Platform</h2>
        <p style="font-size: 13px; color: #94a3b8; margin-bottom: 22px; line-height: 1.5;">
          Scholarly Reviewer & Manuscript Transcription Portal. Sign in with your Google account for editorial access.
        </p>

        <div style="margin-bottom: 14px; text-align: left;">
          <label for="gatePhrase" style="font-size: 11px; color: #94a3b8; display: block; margin-bottom: 4px;">OPTIONAL: As the Hakham would say, Rashi ____ ___ ____! (3 words)</label>
          <input type="text" id="gatePhrase" autocomplete="off" spellcheck="false" maxlength="100" style="width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 6px; border: 1px solid #475569; background: #0f172a; color: #fff; font-size: 13px; outline: none;">
          <div id="gatePhraseMsg" style="display: none; font-size: 12px; color: #fbbf24; margin-top: 6px;"></div>
        </div>

        <!-- Primary: 1-Click Google Sign-In -->
        <button type="button" id="btnGoogleSignIn" style="display: flex; align-items: center; justify-content: center; gap: 12px; width: 100%; padding: 12px 16px; background: #ffffff; color: #1f2937; font-weight: 600; font-size: 14px; border: 1px solid #d1d5db; border-radius: 8px; cursor: pointer; transition: all 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,0.15);">
          <svg width="18" height="18" viewBox="0 0 18 18">
            <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.616z"/>
            <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"/>
            <path fill="#FBBC05" d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.347 6.175 0 7.55 0 9s.347 2.825.957 4.039l3.007-2.332z"/>
            <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"/>
          </svg>
          <span id="btnGoogleSignInLabel">Sign in with Google</span>
        </button>

        <div id="gateErrorMsg" style="color: #f87171; font-size: 12px; display: none; line-height: 1.4; margin-top: 12px;"></div>

        <div style="margin-top: 22px; font-size: 11px; color: #64748b; line-height: 1.4;">
          Need access? Contact Chief Editor Ray Habbaz at <a href="mailto:${MASTER_EMAIL}" style="color: #38bdf8; text-decoration: none;">${MASTER_EMAIL}</a>.
        </div>
      </div>
    `;

    loadFirebaseAuthSdk().catch(() => {}); // preload so the click can open the popup immediately

    const phraseInput = document.getElementById('gatePhrase');
    const phraseMsg = document.getElementById('gatePhraseMsg');
    phraseInput.addEventListener('input', async () => {
      const h = await hashPhrase(phraseInput.value);
      if (h) sessionStorage.setItem(PHRASE_STORAGE_KEY, h);
      else sessionStorage.removeItem(PHRASE_STORAGE_KEY);
      const ok = h === PHRASE_HASH;
      phraseMsg.dir = 'rtl';
      phraseMsg.style.textAlign = 'center';
      phraseMsg.style.fontSize = '18px';
      phraseMsg.textContent = ok ? 'יעבדוך עמים' : '';
      phraseMsg.style.display = ok ? 'block' : 'none';
    });

    const btnGoogle = document.getElementById('btnGoogleSignIn');
    const btnGoogleLabel = document.getElementById('btnGoogleSignInLabel');
    const errorDiv = document.getElementById('gateErrorMsg');

    // Google Sign-In button handler
    btnGoogle.addEventListener('click', async () => {
      errorDiv.style.display = 'none';
      btnGoogle.disabled = true;
      btnGoogleLabel.textContent = 'Connecting to Google…';

      // No awaits before this call: the popup must open directly from the click or browsers block it.
      const res = await signInWithGoogle();
      if (!res.success) {
        errorDiv.textContent = res.error || 'Google sign-in could not be completed.';
        errorDiv.style.display = 'block';
        btnGoogle.disabled = false;
        btnGoogleLabel.textContent = 'Sign in with Google';
        return;
      }

      if (res.approved) {
        btnGoogleLabel.textContent = 'Approved! Loading…';
        overlay.remove();
        window.location.reload();
      } else {
        // Render pending approval interface
        renderPendingApprovalUI(overlay, res.email, 'pending');
      }
    });
  }

  // Re-verify a cached 'approved' status against /approved_reviewers so a hand-edited
  // localStorage value cannot keep the UI unlocked after revocation (or without approval).
  async function verifyApprovalWithServer() {
    if (!getReviewerEmail() || getReviewerEmail() === MASTER_EMAIL.toLowerCase()) return;
    if (localStorage.getItem(APPROVAL_STATUS_KEY) !== 'approved') return;
    const result = await checkReviewerApproval();
    if (!result.approved && !isApproved()) {
      window.location.reload();
    }
  }

  // Shared header "Sign out" button (present on dashboard, review and editorial pages)
  if (typeof document !== 'undefined') {
    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('#btnSignOut');
      if (btn) signOut();
    });
  }

  // Auto-enforce on DOM load
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', enforceFullSiteGate);
    } else {
      enforceFullSiteGate();
    }
    verifyApprovalWithServer().catch(() => {});
  }

  return {
    getReviewerPasscode,
    setReviewerPasscode,
    promptPasscode,
    checkPasscodeOrPrompt,
    getReviewerFirstName,
    getReviewerLastName,
    getReviewerEmail,
    getReviewerName,
    getReviewerUid,
    getReviewerPhoto,
    getReviewerProvider,
    isApproved,
    isMasterEditor,
    verifyMasterPassword,
    sendLoginAlert,
    isAuthorized,
    enforceFullSiteGate,
    ensureAuthToken,
    checkReviewerApproval,
    requestAccess,
    signInWithGoogle,
    signOut
  };
})();
