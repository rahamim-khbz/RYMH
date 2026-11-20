// Runs before first paint (loaded synchronously in <head>): applies the saved
// theme, sharing the site-wide 'ih_theme' key (dark | sepia | light).
(function () {
  var theme = null;
  try { theme = localStorage.getItem('ih_theme'); } catch (e) {}
  if (theme !== 'dark' && theme !== 'sepia' && theme !== 'light') {
    theme = (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', theme);
  var scale = 1;
  try { scale = parseFloat(localStorage.getItem('ih_reader_font')) || 1; } catch (e) {}
  document.documentElement.style.setProperty('--font-scale', String(Math.min(1.8, Math.max(0.8, scale))));
})();
