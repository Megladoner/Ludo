'use strict';
// Restores the saved board theme before first paint so the table never flashes the wrong colour.
(function () {
  var root = document.documentElement;
  var theme = 'noir';
  try {
    var stored = JSON.parse(localStorage.getItem('parcheesi.settings') || '{}');
    if (['noir', 'classic', 'forest'].indexOf(stored.theme) > -1) theme = stored.theme;
    if (stored.motion) root.classList.add('reduced-motion');
  } catch (error) {}
  root.dataset.theme = theme;
})();
