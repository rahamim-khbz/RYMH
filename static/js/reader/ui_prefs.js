// Reader UI preferences: line-highlight toggle + UI language (he/en).
// Loaded synchronously in <head> so language/highlight state applies before render.
(function () {
  'use strict';
  var LS_LANG = 'rymh.uiLang', LS_HL = 'rymh.lineHighlight';
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  var lang = get(LS_LANG) === 'en' ? 'en' : 'he';
  var hlOn = get(LS_HL) !== 'off';
  var root = document.documentElement;
  root.lang = lang;
  root.dir = lang === 'en' ? 'ltr' : 'rtl';
  if (!hlOn) root.classList.add('no-line-hl');

  var EN = {
    'עמוד': 'Page', 'מתוך': 'of', 'כתב היד': 'Manuscript', 'הערה': 'Note', 'המשך': 'cont.',
    'הערות עמוד': 'Notes, page', 'פתח את כתב היד של עמוד': 'Open manuscript of page',
    'עבור לעמוד': 'Go to page', 'הטקסט לא נטען. נסו לרענן את הדף.': 'Text failed to load. Please refresh.'
  };
  // Translate a Hebrew UI phrase when the UI is English.
  window.RYMH_LANG = lang;
  window.RYMH_T = function (he) { return lang === 'en' && EN[he] ? EN[he] : he; };

  var STATIC_EN = {
    // [selector, attribute or 'text', English]
    items: [
      ['.skip', 'text', 'Skip to text'],
      ['#mobilePagerTabs', 'aria-label', 'View'],
      ['#mobileTabText', 'text', 'Text'],
      ['#mobileTabScan', 'text', 'Manuscript'],
      ['label[for="jumpInput"]', 'text', 'Go to page'],
      ['#jumpInput', 'placeholder', 'Page'],
      ['#jumpForm button[type="submit"]', 'text', 'Go'],
      ['#gridBtn', 'aria-label', 'Page list'],
      ['.bar-tools .group', 'aria-label', 'Font size'],
      ['#fontDown', 'aria-label', 'Smaller font'],
      ['#fontDown', 'text', 'A−'],
      ['#fontUp', 'aria-label', 'Larger font'],
      ['#fontUp', 'text', 'A+'],
      ['#markBtn', 'aria-label', 'Show page markers'],
      ['#markBtn', 'text', 'Pg'],
      ['#themeBtn', 'aria-label', 'Toggle color theme'],
      ['#scanPane', 'aria-label', 'Manuscript'],
      ['.scan-controls', 'aria-label', 'Manuscript zoom'],
      ['#scanZoomOut', 'aria-label', 'Zoom out'],
      ['#scanZoomReset', 'aria-label', 'Fit to width'],
      ['#scanZoomIn', 'aria-label', 'Zoom in'],
      ['#textPane', 'aria-label', 'Text'],
      ['#loading', 'text', 'Loading…'],
      ['.foot a', 'text', 'Proofreader sign-in'],
      ['#grid', 'aria-label', 'Page list'],
      ['.grid-head h2', 'text', 'Pages'],
      ['#gridClose', 'aria-label', 'Close']
    ]
  };

  function applyStatic() {
    if (lang !== 'en') return;
    STATIC_EN.items.forEach(function (it) {
      var el = document.querySelector(it[0]);
      if (!el) return;
      if (it[1] === 'text') el.textContent = it[2]; else el.setAttribute(it[1], it[2]);
    });
  }

  function clearHover() {
    var els = document.querySelectorAll('.is-hover');
    for (var i = 0; i < els.length; i++) els[i].classList.remove('is-hover');
  }

  function buildButtons() {
    var tools = document.querySelector('.bar-tools');
    if (!tools) return;
    var anchor = document.getElementById('readerFlagBarSlot');

    var hl = document.createElement('button');
    hl.type = 'button'; hl.className = 'btn icon'; hl.id = 'hlBtn';
    hl.textContent = '☰';
    function syncHl() {
      hl.setAttribute('aria-pressed', hlOn ? 'true' : 'false');
      var label = lang === 'en'
        ? (hlOn ? 'Line highlighting: on' : 'Line highlighting: off')
        : (hlOn ? 'הדגשת שורות: פעיל' : 'הדגשת שורות: כבוי');
      hl.setAttribute('aria-label', label); hl.title = label;
    }
    hl.addEventListener('click', function () {
      hlOn = !hlOn;
      root.classList.toggle('no-line-hl', !hlOn);
      set(LS_HL, hlOn ? 'on' : 'off');
      if (!hlOn) clearHover();
      syncHl();
    });
    syncHl();

    var lg = document.createElement('button');
    lg.type = 'button'; lg.className = 'btn icon lang-btn'; lg.id = 'langBtn';
    lg.textContent = lang === 'en' ? '🇮🇱' : '🇺🇸';
    var lgLabel = lang === 'en' ? 'עברית' : 'English';
    lg.setAttribute('aria-label', lgLabel); lg.title = lgLabel;
    lg.setAttribute('lang', lang === 'en' ? 'he' : 'en');
    lg.addEventListener('click', function () {
      set(LS_LANG, lang === 'en' ? 'he' : 'en');
      location.reload();
    });

    tools.insertBefore(hl, anchor);
    tools.insertBefore(lg, anchor);
  }

  document.addEventListener('DOMContentLoaded', function () { applyStatic(); buildButtons(); });
  // Run immediately too if the DOM is already parsed (defensive).
  if (document.readyState !== 'loading') { applyStatic(); buildButtons(); }
})();
