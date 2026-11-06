import { PIECES } from './pieces.js';

/* ==========================================================================
   The chessboard: a DOM board whose pieces are real elements, so a move is a
   CSS transform that the browser can animate on the compositor. The board never
   decides what is legal: it asks `getTargets(square)` and reports `onMove`.
   Click-to-move, drag-and-drop (mouse, touch and pen), keyboard play and the
   promotion picker all live here.
   ========================================================================== */

const FILES = 'abcdefgh';
const NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const SVGNS = 'http://www.w3.org/2000/svg';
const same = (a, b) => !!a && !!b && a.color === b.color && a.type === b.type;
const fileOf = (sq) => FILES.indexOf(sq[0]);
const rankOf = (sq) => Number(sq[1]) - 1;
const nameOf = (f, r) => FILES[f] + (r + 1);

export function parseFen(fen) {
  const map = new Map();
  const rows = String(fen).split(' ')[0].split('/');
  for (let i = 0; i < 8; i++) {
    let f = 0;
    for (const ch of rows[i] || '') {
      if (/\d/.test(ch)) { f += Number(ch); continue; }
      map.set(nameOf(f, 7 - i), { color: ch === ch.toUpperCase() ? 'w' : 'b', type: ch.toLowerCase() });
      f++;
    }
  }
  return map;
}

export class Board {
  constructor(root, options = {}) {
    this.root = root;
    this.o = Object.assign({ getTargets: () => [], canMove: () => false, onMove: () => {}, announce: () => {}, autoQueen: () => false, showLegal: () => true, animate: () => true }, options);
    this.orientation = 'white';
    this.pos = new Map();
    this.els = new Map();
    this.sel = null;
    this.targets = [];
    this.last = null;
    this.checkSq = null;
    this.kb = 'e2';
    this.drag = null;
    this.promo = null;
    this.build();
    this.bind();
  }

  /* --------------------------------------------------------------- layout -- */

  build() {
    const root = this.root;
    root.classList.add('ch-board');
    root.textContent = '';
    this.squaresEl = document.createElement('div'); this.squaresEl.className = 'ch-squares';
    this.piecesEl = document.createElement('div'); this.piecesEl.className = 'ch-pieces';
    this.arrowsEl = document.createElementNS(SVGNS, 'svg'); this.arrowsEl.setAttribute('class', 'ch-arrows'); this.arrowsEl.setAttribute('viewBox', '0 0 8 8'); this.arrowsEl.setAttribute('aria-hidden', 'true');
    this.promoEl = document.createElement('div'); this.promoEl.className = 'ch-promo'; this.promoEl.hidden = true;
    root.append(this.squaresEl, this.piecesEl, this.arrowsEl, this.promoEl);
    this.sqEls = new Map();
    for (let i = 0; i < 64; i++) {
      const d = document.createElement('div');
      d.className = 'sq';
      this.squaresEl.appendChild(d);
    }
    this.layoutSquares();
  }

  coords(sq) {
    const f = fileOf(sq), r = rankOf(sq);
    return this.orientation === 'white' ? { x: f, y: 7 - r } : { x: 7 - f, y: r };
  }
  squareAtCell(x, y) {
    return this.orientation === 'white' ? nameOf(x, 7 - y) : nameOf(7 - x, y);
  }
  layoutSquares() {
    const cells = this.squaresEl.children;
    this.sqEls.clear();
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const el = cells[y * 8 + x];
      const sq = this.squareAtCell(x, y);
      el.dataset.sq = sq;
      el.className = 'sq ' + ((fileOf(sq) + rankOf(sq)) % 2 === 0 ? 'dark' : 'light');
      el.textContent = '';
      if (x === 0) { const c = document.createElement('i'); c.className = 'coord coord-rank'; c.textContent = sq[1]; el.appendChild(c); }
      if (y === 7) { const c = document.createElement('i'); c.className = 'coord coord-file'; c.textContent = sq[0]; el.appendChild(c); }
      this.sqEls.set(sq, el);
    }
    this.paintMarks();
  }

  setOrientation(side) {
    if (side === this.orientation) return;
    this.orientation = side;
    this.layoutSquares();
    for (const [sq, el] of this.els) this.place(el, sq, false);
    this.paintArrows();
  }
  flip() { this.setOrientation(this.orientation === 'white' ? 'black' : 'white'); }

  place(el, sq, animate) {
    const { x, y } = this.coords(sq);
    if (!animate) { el.classList.add('no-anim'); }
    el.style.transform = 'translate(' + x * 100 + '%,' + y * 100 + '%)';
    el.dataset.sq = sq;
    if (!animate) { void el.offsetWidth; el.classList.remove('no-anim'); }
  }

  makePiece(piece, sq) {
    const el = document.createElement('div');
    el.className = 'pc pc-' + piece.color;
    el.dataset.p = piece.color + piece.type;
    el.innerHTML = PIECES[piece.color + piece.type];
    this.piecesEl.appendChild(el);
    this.place(el, sq, false);
    return el;
  }

  /* ------------------------------------------------------------- position -- */

  // Brings the board to `fen`, sliding pieces that exist in both positions and fading the rest.
  setPosition(fen, opts = {}) {
    const next = parseFen(fen);
    const animate = opts.animate !== false && this.o.animate();
    const vanished = [], needed = [];
    for (const [sq, el] of this.els) {
      if (!same(next.get(sq), this.pos.get(sq))) vanished.push({ sq, el, piece: this.pos.get(sq) });
    }
    for (const [sq, piece] of next) {
      if (!(this.els.has(sq) && same(this.pos.get(sq), piece))) needed.push({ sq, piece });
    }
    const dist = (a, b) => Math.max(Math.abs(fileOf(a) - fileOf(b)), Math.abs(rankOf(a) - rankOf(b)));
    const moved = [];
    const take = (need, pred) => {
      let best = -1, bestD = 99;
      vanished.forEach((v, i) => { if (pred(v)) { const d = dist(v.sq, need.sq); if (d < bestD) { bestD = d; best = i; } } });
      return best < 0 ? null : vanished.splice(best, 1)[0];
    };
    const leftovers = [];
    for (const need of needed) {
      const v = take(need, (c) => same(c.piece, need.piece));
      if (v) moved.push({ el: v.el, to: need.sq, piece: need.piece, from: v.sq }); else leftovers.push(need);
    }
    // A promotion: the pawn that vanished one step away becomes the new piece.
    const created = [];
    for (const need of leftovers) {
      const v = need.piece.type !== 'p' && need.piece.type !== 'k' ? take(need, (c) => c.piece && c.piece.type === 'p' && c.piece.color === need.piece.color && dist(c.sq, need.sq) === 1 && Math.abs(rankOf(c.sq) - rankOf(need.sq)) === 1) : null;
      if (v) moved.push({ el: v.el, to: need.sq, piece: need.piece, from: v.sq, promote: true }); else created.push(need);
    }
    const nextEls = new Map();
    for (const [sq, el] of this.els) if (same(next.get(sq), this.pos.get(sq))) nextEls.set(sq, el);
    for (const m of moved) {
      nextEls.set(m.to, m.el);
      if (animate) { m.el.classList.add('moving'); setTimeout(() => m.el.classList.remove('moving'), 360); }
      if (m.promote) { m.el.className = 'pc pc-' + m.piece.color + (animate ? ' moving' : ''); m.el.dataset.p = m.piece.color + m.piece.type; m.el.innerHTML = PIECES[m.piece.color + m.piece.type]; }
      this.place(m.el, m.to, animate && !m.el.classList.contains('dragging'));
    }
    for (const v of vanished) {
      if (animate) { v.el.classList.add('captured'); setTimeout(() => v.el.remove(), 260); } else v.el.remove();
    }
    for (const c of created) {
      const el = this.makePiece(c.piece, c.sq);
      if (animate) { el.classList.add('entering'); requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('entering'))); }
      nextEls.set(c.sq, el);
    }
    this.els = nextEls;
    this.pos = next;
    this.last = opts.lastMove || null;
    this.checkSq = opts.check ? this.kingSquare(opts.check) : null;
    if (this.sel && !this.pos.get(this.sel)) this.clearSelection(true);
    this.paintMarks();
  }

  kingSquare(color) {
    for (const [sq, p] of this.pos) if (p.type === 'k' && p.color === color) return sq;
    return null;
  }

  /* ---------------------------------------------------------------- marks -- */

  paintMarks() {
    const targets = new Map(this.targets.map((t) => [t.to, t]));
    const show = this.o.showLegal();
    for (const [sq, el] of this.sqEls) {
      el.classList.toggle('last', !!this.last && (sq === this.last[0] || sq === this.last[1]));
      el.classList.toggle('sel', sq === this.sel);
      el.classList.toggle('check', sq === this.checkSq);
      const t = targets.get(sq);
      el.classList.toggle('target', !!(t && show && !t.capture));
      el.classList.toggle('target-cap', !!(t && show && t.capture));
      el.classList.toggle('kb', !!(this.kbOn && sq === this.kb));
    }
    for (const [sq, el] of this.els) el.classList.toggle('sel', sq === this.sel);
  }

  setLast(last) { this.last = last; this.paintMarks(); }

  select(sq) {
    this.sel = sq;
    this.targets = sq ? this.o.getTargets(sq) : [];
    this.paintMarks();
  }
  clearSelection(silent) {
    this.sel = null; this.targets = [];
    if (!silent) this.paintMarks();
  }

  // arrows: [{ from, to, kind }]
  setArrows(arrows) { this.arrows = arrows || []; this.paintArrows(); }
  paintArrows() {
    const svg = this.arrowsEl;
    svg.textContent = '';
    for (const a of this.arrows || []) {
      const p = this.coords(a.from), q = this.coords(a.to);
      const x1 = p.x + .5, y1 = p.y + .5, x2 = q.x + .5, y2 = q.y + .5;
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
      const head = .36, tipX = x2 - ux * .08, tipY = y2 - uy * .08;
      const bx = tipX - ux * head, by = tipY - uy * head;
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', 'arrow arrow-' + (a.kind || 'best'));
      const line = document.createElementNS(SVGNS, 'line');
      line.setAttribute('x1', x1 + ux * .18); line.setAttribute('y1', y1 + uy * .18); line.setAttribute('x2', bx); line.setAttribute('y2', by);
      const tri = document.createElementNS(SVGNS, 'polygon');
      tri.setAttribute('points', [tipX, tipY, bx - uy * .2, by + ux * .2, bx + uy * .2, by - ux * .2].join(','));
      g.append(line, tri);
      svg.appendChild(g);
    }
  }

  /* ---------------------------------------------------------- interaction -- */

  bind() {
    const r = this.root;
    r.addEventListener('pointerdown', (e) => this.down(e));
    r.addEventListener('pointermove', (e) => this.move(e));
    r.addEventListener('pointerup', (e) => this.up(e));
    r.addEventListener('pointercancel', (e) => this.cancel(e));
    r.addEventListener('contextmenu', (e) => e.preventDefault());
    r.addEventListener('keydown', (e) => this.key(e));
    r.addEventListener('focus', () => { this.kbOn = r.matches(':focus-visible'); this.paintMarks(); });
    r.addEventListener('blur', () => { this.kbOn = false; this.paintMarks(); });
  }

  sqAt(e) {
    const rect = this.root.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / rect.width * 8), y = Math.floor((e.clientY - rect.top) / rect.height * 8);
    if (x < 0 || x > 7 || y < 0 || y > 7) return null;
    return this.squareAtCell(x, y);
  }

  down(e) {
    if (e.button > 0 || this.promo) return;
    const sq = this.sqAt(e);
    if (!sq) return;
    this.kbOn = false;
    if (this.sel && this.targets.some((t) => t.to === sq)) { e.preventDefault(); this.attempt(this.sel, sq, false); return; }
    const piece = this.pos.get(sq);
    if (piece && this.o.canMove(sq)) {
      e.preventDefault();
      const wasSelected = this.sel === sq;
      this.select(sq);
      const el = this.els.get(sq);
      this.drag = { sq, el, x: e.clientX, y: e.clientY, id: e.pointerId, active: false, wasSelected };
      try { this.root.setPointerCapture(e.pointerId); } catch {}
    } else if (this.sel) {
      this.clearSelection();
    }
  }

  move(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
      d.active = true;
      d.el.classList.add('dragging');
    }
    const rect = this.root.getBoundingClientRect(), s = rect.width / 8;
    d.el.style.transform = 'translate(' + (e.clientX - rect.left - s / 2) + 'px,' + (e.clientY - rect.top - s / 2) + 'px)';
    const over = this.sqAt(e);
    for (const [sq, el] of this.sqEls) el.classList.toggle('hover', sq === over && this.targets.some((t) => t.to === sq));
  }

  up(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    try { this.root.releasePointerCapture(e.pointerId); } catch {}
    for (const el of this.sqEls.values()) el.classList.remove('hover');
    if (!d.active) { if (d.wasSelected) this.clearSelection(); return; }
    d.el.classList.remove('dragging');
    const to = this.sqAt(e);
    if (to && to !== d.sq && this.targets.some((t) => t.to === to)) this.attempt(d.sq, to, true, d.el);
    else this.place(d.el, d.sq, true);
  }

  cancel(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    d.el.classList.remove('dragging');
    this.place(d.el, d.sq, true);
  }

  // A legal destination was chosen. `dropped` pieces are already under the pointer.
  attempt(from, to, dropped, el) {
    const t = this.targets.find((x) => x.to === to);
    if (!t) return;
    const finish = (promotion) => {
      if (dropped && el) this.place(el, to, false);
      this.clearSelection(true);
      const result = this.o.onMove({ from, to, promotion, dropped });
      if (result === false) { if (el) this.place(el, from, true); }
      this.paintMarks();
    };
    if (t.promotion) {
      if (this.o.autoQueen()) return finish('q');
      if (dropped && el) this.place(el, to, false);
      this.openPromo(from, to, (choice) => {
        if (!choice) { if (el) this.place(el, from, true); this.paintMarks(); return; }
        finish(choice);
      });
    } else finish(undefined);
  }

  openPromo(from, to, done) {
    const piece = this.pos.get(from);
    const color = piece ? piece.color : 'w';
    const { x, y } = this.coords(to);
    const down = y === 0;
    const el = this.promoEl;
    el.textContent = '';
    el.hidden = false;
    const back = document.createElement('div'); back.className = 'ch-promo-back';
    el.appendChild(back);
    const menu = document.createElement('div'); menu.className = 'ch-promo-menu'; menu.setAttribute('role', 'group'); menu.setAttribute('aria-label', 'Promote to');
    menu.style.left = x * 12.5 + '%';
    menu.style.top = (down ? 0 : 50) + '%';
    const close = (choice) => {
      document.removeEventListener('keydown', onKey, true);
      el.hidden = true; el.textContent = ''; this.promo = null;
      done(choice);
    };
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(null); } };
    ['q', 'n', 'r', 'b'].forEach((type) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ch-promo-btn'; b.dataset.p = color + type;
      b.setAttribute('aria-label', NAMES[type]);
      b.innerHTML = PIECES[color + type];
      b.addEventListener('click', (ev) => { ev.stopPropagation(); close(type); });
      menu.appendChild(b);
    });
    if (!down) menu.classList.add('up');
    el.appendChild(menu);
    back.addEventListener('click', () => close(null));
    document.addEventListener('keydown', onKey, true);
    this.promo = { close };
    const first = menu.querySelector('button'); if (first) first.focus({ preventScroll: true });
  }

  key(e) {
    if (this.promo) return;
    const move = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
    this.kbOn = true;
    if (move) {
      e.preventDefault();
      const c = this.coords(this.kb);
      const x = Math.max(0, Math.min(7, c.x + move[0])), y = Math.max(0, Math.min(7, c.y + move[1]));
      this.kb = this.squareAtCell(x, y);
      this.paintMarks();
      this.o.announce(this.describe(this.kb));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const sq = this.kb;
      if (this.sel && this.targets.some((t) => t.to === sq)) { this.attempt(this.sel, sq, false); return; }
      const p = this.pos.get(sq);
      if (p && this.o.canMove(sq)) { this.select(sq); this.o.announce(this.describe(sq) + ' selected. ' + this.targets.length + ' moves available'); }
      else { this.clearSelection(); this.o.announce('Nothing to move here'); }
    } else if (e.key === 'Escape') {
      this.clearSelection();
    }
  }

  describe(sq) {
    const p = this.pos.get(sq);
    return sq + ', ' + (p ? (p.color === 'w' ? 'white ' : 'black ') + NAMES[p.type] : 'empty');
  }
}
