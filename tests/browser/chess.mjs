// Drives the real chess UI in headless Chromium against a running Worker (wrangler dev) or server.
// Usage: BASE=http://localhost:8787 node tests/browser/chess.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8787';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const browser = await chromium.launch();
const errors = [];
async function page(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/favicon|404|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return p;
}
const center = async (p, s) => { const r = await p.locator(`#board .sq[data-sq="${s}"]`).boundingBox(); return [r.x + r.width / 2, r.y + r.height / 2]; };
const click = async (p, a, b) => { await p.mouse.click(...await center(p, a)); await p.mouse.click(...await center(p, b)); await p.waitForTimeout(120); };
const drag = async (p, a, b) => { await p.mouse.move(...await center(p, a)); await p.mouse.down(); await p.mouse.move(...await center(p, b), { steps: 5 }); await p.mouse.up(); await p.waitForTimeout(150); };
const startLocal = async (p, tc = '10+0') => {
  await p.goto(BASE + '/chess/local'); await p.click(`#setup-tc .ch-tc[data-tc="${tc}"]`); await p.click('#setup-side button[data-side="white"]');
  await p.click('#setup-confirm'); await p.waitForSelector('#game-view:not(.hidden)');
};

// Landing + routes
{
  const p = await page();
  await p.goto(BASE + '/'); ok('landing offers Ludo and Chess', await p.locator('#card-ludo').count() === 1 && await p.locator('#card-chess').count() === 1);
  await p.click('#card-chess'); await p.waitForURL('**/chess/'); ok('chess card opens chess', await p.isVisible('#menu-view'));
  await p.goto(BASE + '/ludo/'); ok('Ludo home loads at /ludo/', await p.isVisible('#home-view'));
  ok('Ludo has a way back to all games', await p.locator('#all-games-link').count() === 1);
  await p.goto(BASE + '/chess/room/NOSUCHRM'); await p.waitForURL('**/chess/'); ok('invalid room link falls back to menu', await p.isVisible('#menu-view'));
  await p.close();
}
// Pass & play: click, drag, promotion, mate
{
  const p = await page(); await startLocal(p);
  ok('32 pieces on the board', await p.locator('#board .pc').count() === 32);
  await p.mouse.click(...await center(p, 'e2')); ok('legal-move marks shown', await p.locator('#board .sq.target').count() === 2);
  await p.mouse.click(...await center(p, 'e4')); await p.waitForTimeout(200);
  await drag(p, 'e7', 'e5');
  ok('click and drag both play moves', (await p.textContent('#move-list')).includes('e4') && (await p.textContent('#move-list')).includes('e5'));
  await p.mouse.click(...await center(p, 'e7')); await p.mouse.click(...await center(p, 'e5'));
  ok('illegal move rejected (no new ply)', await p.locator('.mv').count() === 2);
  await p.goto(BASE + '/chess/local'); // resumes saved game
  ok('refresh keeps the pass & play game', await p.locator('.mv').count() === 2);
  await p.click('#nav-first'); ok('review steps back', await p.textContent('#live-dot') === 'REVIEW');
  await p.click('#nav-last');
  await p.close();
}
{
  const p = await page(); await startLocal(p);
  for (const [a, b] of [['a2', 'a4'], ['b7', 'b5'], ['a4', 'b5'], ['a7', 'a6'], ['b5', 'a6'], ['c8', 'b7'], ['a6', 'b7'], ['g8', 'f6']]) await click(p, a, b);
  await p.mouse.click(...await center(p, 'b7')); await p.mouse.click(...await center(p, 'a8'));
  await p.waitForSelector('.ch-promo:not([hidden]) .ch-promo-btn'); ok('promotion picker shown', await p.locator('.ch-promo-btn').count() === 4);
  await p.locator('.ch-promo-btn[data-p="wq"]').click(); await p.waitForTimeout(200);
  ok('promotion recorded as =Q', (await p.textContent('#move-list')).includes('=Q'));
  await p.close();
}
{
  const p = await page(); await startLocal(p);
  for (const [a, b] of [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]) await click(p, a, b);
  await p.waitForSelector('#result-card:not([hidden])');
  ok('checkmate ends the game', (await p.textContent('#result-sub')).toLowerCase().includes('checkmate'), await p.textContent('#result-sub'));
  ok('mate status explained in text', /checkmate/i.test(await p.textContent('#status-line')));
  // analysis
  await p.click('#btn-analyze'); await p.waitForSelector('#an-summary .an-side', { timeout: 60000 });
  ok('analysis flags the blunders', (await p.locator('.mk-blunder').count()) >= 1);
  ok('eval bar visible during analysis', await p.isVisible('#evalbar'));
  await p.close();
}
// Themes persist and recolour
{
  const p = await page(); await p.goto(BASE + '/chess/'); await p.click('#settings-open');
  const colors = [];
  for (const t of ['noir', 'classic', 'forest']) {
    await p.locator(`input[name="ctheme"][value="${t}"]`).check({ force: true });
    colors.push(await p.evaluate(() => getComputedStyle(document.querySelector('#menu-board .sq.dark')).backgroundColor + getComputedStyle(document.body).backgroundColor));
  }
  ok('three themes give three different looks', new Set(colors).size === 3, colors.join('|'));
  await p.reload(); ok('theme persists across reload', await p.evaluate(() => document.documentElement.dataset.chessTheme) === 'forest');
  await p.close();
}
// Computer
{
  const p = await page(); await p.goto(BASE + '/chess/computer');
  ok('seven levels offered', await p.locator('#setup-levels .ch-level').count() === 7);
  await p.click('#setup-levels .ch-level[data-level="1"]'); await p.click('#setup-side button[data-side="white"]'); await p.click('#setup-confirm');
  await click(p, 'e2', 'e4'); await p.waitForFunction(() => document.querySelectorAll('.mv').length >= 2, null, { timeout: 30000 });
  ok('Stockfish replies', true);
  await p.close();
}
// Online
{
  const A = await page(), B = await page();
  await A.goto(BASE + '/chess/'); await A.click('#m-friends'); await A.fill('#create-name', 'Alice');
  await A.click('#create-tc .ch-tc[data-tc="3+0"]'); await A.click('#create-side button[data-side="white"]'); await A.click('#create-confirm');
  await A.waitForURL(/chess\/room\//); await A.waitForSelector('#lobby-view:not(.hidden)');
  const url = A.url();
  const C = await page(); await C.goto(url); await C.waitForSelector('#join-dialog[open]', { timeout: 5000 }).catch(() => {}); ok('stranger gets a name prompt, not a seat', await C.isVisible('#join-dialog')); await C.close();
  await B.goto(url); await B.fill('#join-name', 'Bob'); await B.click('#join-confirm'); await B.waitForSelector('#lobby-view:not(.hidden)');
  await A.waitForFunction(() => !document.getElementById('start-game').disabled); await A.click('#start-game');
  await A.waitForSelector('#game-view:not(.hidden)'); await B.waitForSelector('#game-view:not(.hidden)');
  ok('Bob plays Black, board flipped', await B.evaluate(() => document.querySelector('#pl-bottom .ch-pmeta').textContent.startsWith('Black')));
  ok('clock is not running before both have moved', await A.locator('.ch-clock.running').count() === 0);
  await click(A, 'e2', 'e4'); await click(B, 'e7', 'e5'); await click(A, 'g1', 'f3');
  ok('both sides see the same moves', (await A.textContent('#move-list')) === (await B.textContent('#move-list')));
  await B.mouse.click(...await center(B, 'e5')); ok('cannot move out of turn', await B.locator('#board .sq.target').count() === 0);
  await B.reload(); await B.waitForSelector('#game-view:not(.hidden)'); await B.waitForTimeout(500);
  ok('refresh restores the room and moves', (await B.locator('.mv').count()) === 3 && (await B.textContent('#pl-bottom .ch-pname')).includes('Bob'));
  const ca = await A.textContent('#pl-top .ch-clock'), cb = await B.textContent('#pl-top .ch-clock');
  ok('clocks agree within a second', Math.abs(parseInt(ca.split(':')[1]) - parseInt(cb.split(':')[1])) <= 2 || ca === cb, ca + ' ' + cb);
  await A.evaluate(() => document.getElementById('tab-btn-chat').click()); await B.evaluate(() => document.getElementById('tab-btn-chat').click());
  await B.fill('#chat-input', 'hello'); await B.click('#chat-send'); await A.waitForFunction(() => document.getElementById('chat-list').textContent.includes('hello'));
  ok('chat arrives', true);
  await B.evaluate(() => { document.getElementById('draw-accept'); }); 
  await B.click('#btn-draw').catch(() => {}); await A.waitForSelector('#draw-banner:not([hidden])'); ok('draw offer arrives', true);
  await A.click('#draw-decline'); await A.click('#btn-resign'); await A.click('#confirm-ok');
  await A.waitForSelector('#result-card:not([hidden])'); await B.waitForSelector('#result-card:not([hidden])');
  ok('resignation shown to both', /resigned/.test(await B.textContent('#result-sub')));
  await A.click('#btn-analyze'); await A.waitForSelector('#an-summary .an-side', { timeout: 60000 });
  await B.click('#btn-analyze'); await B.waitForSelector('#an-summary .an-side', { timeout: 60000 }); ok('analysis available to both players', true);
  await A.close(); await B.close();
}
// Abort before both moved
{
  const A = await page(), B = await page();
  await A.goto(BASE + '/chess/'); await A.click('#m-friends'); await A.fill('#create-name', 'Ann'); await A.click('#create-confirm');
  await A.waitForURL(/chess\/room\//); const url = A.url();
  await B.goto(url); await B.fill('#join-name', 'Ben'); await B.click('#join-confirm');
  await A.waitForFunction(() => !document.getElementById('start-game').disabled); await A.click('#start-game');
  await A.waitForSelector('#btn-abort:not([hidden])'); ok('Abort (not Resign) offered before first moves', await A.isHidden('#btn-resign'));
  await A.click('#btn-abort'); await A.click('#confirm-ok'); await A.waitForSelector('#result-card:not([hidden])');
  ok('aborted game reported', /abort/i.test(await A.textContent('#result-sub')));
  await A.close(); await B.close();
}
// Mobile
{
  const p = await page({ ...devices['iPhone 13'] }); await startLocal(p);
  ok('mobile: no horizontal overflow', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const r = await p.locator('#board').boundingBox(); ok('mobile: board fits the width', r.width <= 390 && r.width > 300);
  await p.close();
}
ok('no uncaught page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(`TOTAL ${pass + fail}  PASSED ${pass}  FAILED ${fail}`);
process.exit(fail ? 1 : 0);
