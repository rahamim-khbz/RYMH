// Firebase web app & RTDB configuration for the public reader.
(function (root) {
  'use strict';

  root.FIREBASE_CONFIG = root.FIREBASE_CONFIG || {
    apiKey: 'AIzaSyBmFOK7Iej8WHSaWyO2RxARVaxrdhdqJds',
    authDomain: 'iyye-hayyam.firebaseapp.com',
    projectId: 'iyye-hayyam',
    appId: '1:248504429327:web:159a3e242448ee4d1c2c7a',
    databaseURL: 'https://iyye-hayyam-default-rtdb.firebaseio.com'
  };

  // Allow local RTDB emulator overrides (?emulator=... / ?rtdb_emulator=...) on localhost.
  var loc = root.location || {};
  var host = String(loc.hostname || '');
  var isLocal = host === 'localhost' || host === '127.0.0.1';
  var hasEmu = false;
  if (isLocal) {
    try {
      var params = new URLSearchParams(String(loc.search || ''));
      if (params.get('emulator') || params.get('rtdb_emulator')) hasEmu = true;
    } catch (e) {}
    try {
      if (root.localStorage && root.localStorage.getItem('ih_reader_emulator_url')) hasEmu = true;
    } catch (e) {}
  }

  if (!hasEmu) {
    root.FIREBASE_DB_URL = root.FIREBASE_DB_URL || 'https://iyye-hayyam-default-rtdb.firebaseio.com';
  }

  function prewarmFirebaseAuth(fb) {
    if (!fb) return;
    try {
      if (fb.apps && !fb.apps.length && root.FIREBASE_CONFIG) {
        fb.initializeApp(root.FIREBASE_CONFIG);
      }
      if (typeof fb.auth === 'function') {
        var auth = fb.auth();
        var d = auth && auth._delegate;
        if (d && d._popupRedirectResolver && typeof d._popupRedirectResolver._initialize === 'function') {
          Promise.resolve(d._popupRedirectResolver._initialize(d)).catch(function () {});
        }
      }
    } catch (e) {}
  }

  root.prewarmReaderFirebaseAuth = prewarmFirebaseAuth;
  prewarmFirebaseAuth(root.firebase);
})(typeof window !== 'undefined' ? window : globalThis);
