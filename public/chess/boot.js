'use strict';
// Restores the saved chess theme before first paint so the board never flashes the wrong colours.
(function () {
  var root = document.documentElement;
  var theme = 'noir';
  try {
    var stored = JSON.parse(localStorage.getItem('parcheesi.chess') || '{}');
    if (['noir', 'classic', 'forest'].indexOf(stored.theme) > -1) theme = stored.theme;
    if (stored.motion) root.classList.add('reduced-motion');
  } catch (error) {}
  root.dataset.chessTheme = theme;
})();
