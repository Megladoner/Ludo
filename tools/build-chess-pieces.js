'use strict';
// Converts the cburnett piece sprite (cm-chessboard's standard.svg, CC BY-SA 3.0) into
// public/chess/pieces.js, one inline <svg> per piece. Run once; the output is committed.
//   node tools/build-chess-pieces.js path/to/standard.svg
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(process.argv[2], 'utf8');
const out = {};
const re = /<g id="([wb][kqrbnp])"([\s\S]*?)\n    <\/g>/g;
let m;
while ((m = re.exec(src))) {
  const body = ('<g id="' + m[1] + '"' + m[2] + '\n</g>')
    .replace(/\s+id="[^"]*"/g, '')
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><');
  out[m[1]] = '<svg viewBox="2.5 2.5 35 35" aria-hidden="true" focusable="false">' + body + '</svg>';
}
if (Object.keys(out).length !== 12) throw new Error('expected 12 pieces, found ' + Object.keys(out).length);
const header = '// Chess piece artwork: "Cburnett" set by Colin M.L. Burnett (Wikimedia Commons), CC BY-SA 3.0,\n// via the cm-chessboard sprite (MIT). Colours are applied by CSS so every theme restyles them.\n';
fs.writeFileSync(path.join(__dirname, '../public/chess/pieces.js'), header + 'export const PIECES = ' + JSON.stringify(out, null, 1) + ';\n');
console.log('wrote', Object.keys(out).join(' '));
