// Reader UI preferences: line-highlight toggle + UI language (he/en).
// Loaded synchronously in <head> so language/highlight state applies before render.
(function () {
  'use strict';
  var LS_LANG = 'rymh.uiLang', LS_HL = 'rymh.lineHighlight';
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  var lang = get(LS_LANG) === 'en' ? 'en' : 'he';
  var hlOn = get(LS_HL) === 'on';
  var root = document.documentElement;
  root.lang = lang;
  root.dir = lang === 'en' ? 'ltr' : 'rtl';
  if (!hlOn) root.classList.add('no-line-hl');

  var EN = {
    'עמוד': 'Page', 'מתוך': 'of', 'הדפוס': 'Printed', 'הערה': 'Note', 'המשך': 'cont.',
    'הערות עמוד': 'Notes, page', 'פתח את הדפוס של עמוד': 'Open printed page',
    'עבור לעמוד': 'Go to page', 'הסתר את צילום הדפוס': 'Hide the printed scan',
    'הצג את צילום הדפוס': 'Show the printed scan', 'הטקסט לא נטען. נסו לרענן את הדף.': 'Text failed to load. Please refresh.'
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
      ['#mobileTabScan', 'text', 'Printed'],
      ['#pageSelectLabel', 'text', 'Go to page'],
      ['#pageSelect', 'aria-label', 'Go to page'],
      ['#scanToggle', 'text', 'Printed'],
      ['#gridBtn', 'aria-label', 'Page list'],
      ['.bar-tools .group', 'aria-label', 'Font size'],
      ['#fontDown', 'aria-label', 'Smaller font'],
      ['#fontDown', 'text', 'A−'],
      ['#fontUp', 'aria-label', 'Larger font'],
      ['#fontUp', 'text', 'A+'],
      ['#markBtn', 'aria-label', 'Show page markers'],
      ['#markBtn', 'text', 'Pg'],
      ['#settingsBtn', 'aria-label', 'Display settings'],
      ['#settingsPop', 'aria-label', 'Display settings'],
      ['#themeBtn', 'aria-label', 'Toggle color theme'],
      ['#scanPane', 'aria-label', 'Printed'],
      ['.scan-controls', 'aria-label', 'Printed page zoom'],
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
      var nextLang = lang === 'en' ? 'he' : 'en';
      set(LS_LANG, nextLang);
      set('iyye_ui_lang', nextLang);
      location.reload();
    });

    var pop = document.getElementById('settingsPop');
    if (pop) pop.appendChild(hl); else tools.insertBefore(hl, anchor);
    tools.insertBefore(lg, anchor);
  }

  // "Aa" display-settings popover (font, markers, theme, line highlight).
  function bindSettings() {
    var btn = document.getElementById('settingsBtn');
    var pop = document.getElementById('settingsPop');
    if (!btn || !pop) return;
    // Desktop/tablet: the controls sit on the toolbar. Phones (<= 560px): behind "Aa".
    var phone = window.matchMedia ? window.matchMedia('(max-width: 560px)') : { matches: false };
    function isPhone() { return phone.matches; }
    function show(open) {
      pop.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    function applyLayout() {
      btn.hidden = !isPhone();
      show(!isPhone());
    }
    applyLayout();
    if (phone.addEventListener) phone.addEventListener('change', applyLayout);
    else if (phone.addListener) phone.addListener(applyLayout);
    btn.addEventListener('click', function (ev) { ev.stopPropagation(); show(pop.hidden); });
    document.addEventListener('click', function (ev) {
      if (isPhone() && !pop.hidden && !pop.contains(ev.target) && ev.target !== btn) show(false);
    });
    document.addEventListener('keydown', function (ev) {
      if (isPhone() && ev.key === 'Escape' && !pop.hidden) { show(false); btn.focus(); }
    });
  }

  // Hover tooltips: every toolbar/scan control shows its (localized) label on hover.
  function syncTooltips() {
    var els = document.querySelectorAll('.bar button[aria-label], .bar select[aria-label], .scan-controls button[aria-label]');
    for (var i = 0; i < els.length; i++) els[i].title = els[i].getAttribute('aria-label');
  }
  function watchTooltips() {
    syncTooltips();
    var bar = document.getElementById('bar');
    if (bar && window.MutationObserver) {
      new MutationObserver(syncTooltips).observe(bar, { subtree: true, attributes: true, attributeFilter: ['aria-label'], childList: true });
    }
  }

  var started = false;
  function start() {
    if (started) return;
    started = true;
    applyStatic(); buildButtons(); bindSettings(); watchTooltips();
  }
  document.addEventListener('DOMContentLoaded', start);
  // Run immediately too if the DOM is already parsed (defensive).
  if (document.readyState !== 'loading') start();
})();
