/* ux3d.js - lightweight add-on (v3): count-up numbers on the stat cards + Alt+1..3 page shortcuts.
   (v2 looked for element ids / classes that do not exist in index.html, so none of it ever ran - fixed.)
   Wrapped in try/catch so it can never block the page. */
(function () {
  'use strict';
  try {
    var calm = matchMedia('(prefers-reduced-motion:reduce)').matches, prev = [], stats = document.getElementById('stats');
    if (stats) new MutationObserver(function () {          // script.js re-renders #stats on every fetch
      var els = stats.querySelectorAll('.stat b'), tok = stats._t = (stats._t || 0) + 1, cur = [];
      els.forEach(function (el, i) {
        var to = parseFloat((el.textContent || '').replace(/,/g, '')), from = prev[i] === undefined ? 0 : prev[i];
        cur[i] = to;
        if (calm || isNaN(to) || !Number.isInteger(to) || !Number.isInteger(from) || Math.abs(to - from) < 2) return;
        var t0 = performance.now();
        (function step(t) {
          if (stats._t !== tok || !el.isConnected) return;
          var p = Math.min((t - t0) / 700, 1);
          el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))).toLocaleString('en-IN');
          if (p < 1) requestAnimationFrame(step);
        })(t0);
      });
      prev = cur;
    }).observe(stats, { childList: true });

    document.addEventListener('keydown', function (e) {
      if (!e.altKey || e.ctrlKey || e.metaKey || !document.body.classList.contains('authed')) return;
      var tabs = document.querySelectorAll('#mainNav button:not(.hide)'), i = parseInt(e.key, 10) - 1;
      if (tabs[i]) { e.preventDefault(); tabs[i].click(); }
    });

    var hint = document.createElement('div'); hint.className = 'kbhint hide';
    hint.innerHTML = '<kbd>Alt</kbd>+<kbd>1</kbd>-<kbd>3</kbd> switch pages'; document.body.appendChild(hint);
    var sync = function () { hint.classList.toggle('hide', !document.body.classList.contains('authed')); };
    new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] }); sync();
  } catch (err) { console.warn('ux3d disabled:', err); }
})();
