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

  try {
    if (root.firebase && root.firebase.apps && !root.firebase.apps.length && root.FIREBASE_CONFIG) {
      root.firebase.initializeApp(root.FIREBASE_CONFIG);
    }
  } catch (e) {}
})(typeof window !== 'undefined' ? window : globalThis);
