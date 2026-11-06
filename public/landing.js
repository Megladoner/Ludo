// Shows a small "game in progress" hint on each card. Everything here is optional.
(function () {
  function read(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
  function hint(id, text) { var el = document.getElementById(id); if (el && text) { el.textContent = text; el.hidden = false; } }
  var off = read('parcheesi.chess.offline');
  var last = read('parcheesi.chess.lastRoom');
  var chess = null;
  if (last && last.code && Date.now() - last.at < 864e5) { try { if (localStorage.getItem('parcheesi:chess:' + last.code)) chess = 'Room ' + last.code + ' in progress'; } catch (e) {} }
  if (!chess && off && off.g && !off.g.result) chess = 'Game in progress';
  hint('resume-chess', chess);
  var ludo = read('parcheesi.lastRoom');
  if (ludo && ludo.invite && Date.now() - ludo.at < 864e5) { try { if (localStorage.getItem('parcheesi:' + ludo.invite)) hint('resume-ludo', 'Table ' + ludo.invite + ' in progress'); } catch (e) {} }
})();
