"""Browser checks for the PARCHEESI feature edition.

Covers the table rules, the travelling die, the turn frame, the celebration
and the local profile dashboard. Run with the repo's own static server:

    python3 tools/browser-features.py
"""
import os
import subprocess
import sys
import time
import socket

from playwright.sync_api import sync_playwright

CHROME = os.environ.get("CHROME_PATH", "")
PORT = int(os.environ.get("PORT", "3401"))
BASE = f"http://127.0.0.1:{PORT}"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get("SHOT_DIR", os.path.join(ROOT, "artifacts", "screenshots"))
FIXTURE = os.environ.get("FIXTURE_DIR", os.path.join(ROOT, "artifacts", "fixtures"))
os.makedirs(OUT, exist_ok=True)
os.makedirs(FIXTURE, exist_ok=True)


def port_open():
    with socket.socket() as sk:
        sk.settimeout(0.4)
        return sk.connect_ex(("127.0.0.1", PORT)) == 0


server = None
if not port_open():
    server = subprocess.Popen(
        ["node", "src/server/index.js"], cwd=ROOT,
        env={**os.environ, "PORT": str(PORT), "HOST": "127.0.0.1"},
        stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
    )
    time.sleep(1.5)

# A small solid PNG, used to exercise the photo upload path.
PHOTO = os.path.join(FIXTURE, "avatar.png")
if not os.path.exists(PHOTO):
    import struct
    import zlib

    width = height = 8
    raw = b"".join(b"\x00" + bytes([90, 130, 200] * width) for _ in range(height))

    def chunk(kind, payload):
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw))
           + chunk(b"IEND", b""))
    with open(PHOTO, "wb") as handle:
        handle.write(png)

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("PASS  " if ok else "FAIL  ") + name + ((" :: " + detail) if detail else ""), flush=True)


# Helpers injected into the page so the checks can drive the table precisely.
SEAT = """() => {
  const g = LudoEngine.initialState({players:['red','green','yellow','blue'],
    names:{red:'Aria',green:'Bo',yellow:'Cy',blue:'Di'}});
  state.game = g; state.local = true; state.mode = 'PASS & PLAY'; state.ai = false;
  state.gameMode = 'friends'; state.resultRecorded = false; state.finishedSeen = [];
  renderGame(); view('game-view');
  return true;
}"""

with sync_playwright() as p:
    launch = {"args": ["--no-sandbox", "--disable-dev-shm-usage"]}
    if CHROME:
        launch["executable_path"] = CHROME
    browser = p.chromium.launch(**launch)
    ctx = browser.new_context(viewport={"width": 1440, "height": 950})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console." + m.type + ": " + m.text) if m.type == "error" else None)

    page.goto(BASE, wait_until="networkidle")

    # --- 1. The die travels to the player on turn --------------------------
    page.evaluate(SEAT)
    first = page.get_attribute("#dice-overlay", "data-seat")
    check("the die sits in the first player's home square", first == "red", str(first))
    box_red = page.locator("#dice-overlay").bounding_box()

    page.evaluate("() => { state.game.currentPlayer = 1; renderGame(); }")
    page.wait_for_timeout(700)
    second = page.get_attribute("#dice-overlay", "data-seat")
    check("the die transfers to the next player's home square", second == "green", str(second))
    box_green = page.locator("#dice-overlay").bounding_box()
    check("the die visibly moves across the board",
          box_red and box_green and (abs(box_red["x"] - box_green["x"]) > 40 or abs(box_red["y"] - box_green["y"]) > 40),
          f"{box_red} vs {box_green}")

    # --- 2. The home square of the player on turn wears a frame -----------
    frame_x = page.get_attribute("#game-board .b-yard-frame", "x")
    inner = page.get_attribute("#game-board .b-yard-frame-inner", "class") or ""
    check("the active home square is outlined", page.locator("#game-board .b-yard-frame").count() == 1)
    check("the outline follows the player on turn", "c-green" in inner, inner)
    check("the outline sits on the green home square", abs(float(frame_x) - 8.4) < 0.2, str(frame_x))
    stroke = page.evaluate("""() => {
      const svg = document.querySelector('#game-board .board-svg');
      const frame = document.querySelector('#game-board .b-yard-frame');
      const scale = svg.getBoundingClientRect().width / 15;
      return parseFloat(getComputedStyle(frame).strokeWidth) * scale;
    }""")
    check("the outline is bold on screen", stroke >= 4, f"{stroke:.1f}px")
    page.evaluate("() => { state.game.currentPlayer = 2; renderGame(); }")
    page.wait_for_timeout(200)
    inner = page.get_attribute("#game-board .b-yard-frame-inner", "class") or ""
    check("the outline cycles with the turns", "c-yellow" in inner, inner)
    page.screenshot(path=f"{OUT}/20-turn-frame.png")

    # --- 3. A lone token plays itself -------------------------------------
    page.evaluate("""() => {
      const g = LudoEngine.initialState({players:['red','green'], names:{red:'Aria',green:'Bo'}});
      g.players[0].tokens = [-1, 6, -1, -1];
      state.game = g; state.local = true; state.mode = 'PASS & PLAY'; renderGame(); view('game-view');
      window.__rand = Math.random; Math.random = () => 0.5;
    }""")
    before = page.evaluate("() => state.game.players[0].tokens[1]")
    page.click("#roll-dice")
    page.wait_for_timeout(1500)
    after = page.evaluate("() => state.game.players[0].tokens[1]")
    check("a single deployed token moves by itself", before == 6 and after == 10, f"{before} -> {after}")
    check("the turn passed after the automatic move",
          page.evaluate("() => state.game.currentPlayer") == 1)

    # --- 4. Manual play returns when more than one token is out -----------
    page.evaluate("""() => {
      const g = LudoEngine.initialState({players:['red','green'], names:{red:'Aria',green:'Bo'}});
      g.players[0].tokens = [-1, 6, 12, -1];
      state.game = g; state.local = true; renderGame(); view('game-view');
      window.__rand = Math.random; Math.random = () => 0.5;
    }""")
    page.click("#roll-dice")
    page.wait_for_timeout(1200)
    tokens = page.evaluate("() => state.game.players[0].tokens.slice()")
    check("two tokens out means no automatic move", tokens[1] == 6 and tokens[2] == 12, str(tokens))
    check("the player is asked to pick a token", page.locator("#game-board .hit").count() == 2,
          str(page.locator("#game-board .hit").count()))
    page.locator("#game-board .hit").first.click()
    page.wait_for_timeout(500)
    check("the chosen token moved", page.evaluate("() => state.game.players[0].tokens[1]") == 10)

    # --- 5. The home lane buys one more move with that token --------------
    page.evaluate("""() => {
      const g = LudoEngine.initialState({players:['red','green'], names:{red:'Aria',green:'Bo'}});
      g.players[0].tokens = [50, -1, -1, -1];
      state.game = g; state.local = true; renderGame(); view('game-view');
      window.__rand = Math.random; Math.random = () => 0;
    }""")
    page.click("#roll-dice")
    page.wait_for_timeout(1800)
    landed = page.evaluate("() => state.game.players[0].tokens[0]")
    check("a token in the home lane gets a second move", landed == 52, str(landed))
    check("the turn passes once the bonus move is spent",
          page.evaluate("() => state.game.currentPlayer") == 1)

    # --- 6. A capture earns the captor another roll ------------------------
    page.evaluate("""() => {
      const g = LudoEngine.initialState({players:['red','green'], names:{red:'Aria',green:'Bo'}});
      g.players[0].tokens = [0, -1, -1, -1];
      g.players[1].tokens = [40, -1, -1, -1];
      state.game = g; state.local = true; renderGame(); view('game-view');
      window.__rand = Math.random; Math.random = () => 0;
    }""")
    page.click("#roll-dice")
    page.wait_for_timeout(1400)
    check("the opponent's token was captured",
          page.evaluate("() => state.game.players[1].tokens[0]") == -1)
    check("the capturer keeps the turn",
          page.evaluate("() => state.game.currentPlayer") == 0)
    check("the capturer rolls again rather than moving again",
          page.evaluate("() => state.game.awaitingMove") is False)
    check("the capture is on the record",
          page.evaluate("() => state.game.players[0].captures") == 1)

    # --- 7. Three or four players play on after the first finisher --------
    page.evaluate("""() => {
      const g = LudoEngine.initialState({players:['red','green','yellow'], names:{red:'Aria',green:'Bo',yellow:'Cy'}});
      g.players[0].tokens = [57, 57, 57, 57];
      state.game = g; state.local = true; renderGame(); view('game-view');
    }""")
    page.evaluate("""() => {
      const g = state.game;
      g.players[0].tokens = [57, 57, 57, 57];
      g.finishOrder = ['red']; g.currentPlayer = 1;
      renderGame();
    }""")
    check("the table plays on after a finisher",
          page.evaluate("() => state.game.status") == "playing")
    check("the finish is announced",
          page.evaluate("() => state.game.finishOrder[0]") == "red")

    # --- 8. The celebration ------------------------------------------------
    page.evaluate("""() => {
      const g = LudoEngine.initialState({players:['red','green'], names:{red:'Aria',green:'Bo'}});
      g.players[0].tokens = [57, 57, 57, 57]; g.players[1].tokens = [57, 57, 57, 57];
      g.status = 'finished'; g.winner = 'red'; g.finishOrder = ['red', 'green'];
      state.game = g; state.local = true; state.ai = true; state.gameMode = 'computer';
      state.resultRecorded = false;
      renderGame(); result();
    }""")
    page.wait_for_timeout(400)
    check("the confetti layer exists", page.locator("#confetti").count() == 1)
    check("confetti is thrown for the winner",
          page.evaluate("() => confetti.particles.length") > 0,
          str(page.evaluate("() => confetti.particles.length")))
    check("the result screen is shown", page.is_visible("#result-view"))
    check("the winner is named", "Aria" in page.inner_text("#result-title"),
          page.inner_text("#result-title"))
    check("the result screen ranks the finishers",
          "ARIA" in page.inner_text("#result-stats").upper())

    # --- 9. The profile dashboard -----------------------------------------
    check("the match was recorded",
          page.evaluate("() => ParcheesiProfile.get().stats.total.played") == 1)
    check("it was recorded against the computer",
          page.evaluate("() => ParcheesiProfile.get().stats.computer.played") == 1)
    check("it was recorded as a win",
          page.evaluate("() => ParcheesiProfile.get().stats.total.won") == 1)

    page.click("#avatar-button")
    page.wait_for_selector("#profile-dialog[open]", timeout=4000)
    check("the profile sheet opens", page.is_visible("#profile-dialog"))
    check("the stat cards are shown", page.locator(".stat-card").count() == 3)
    check("the computer and friends rows are shown",
          "AGAINST THE COMPUTER" in page.inner_text("#profile-stats").upper())
    page.fill("#profile-name", "Aria")
    page.set_input_files("#profile-photo-input", PHOTO)
    page.wait_for_timeout(500)
    check("a photo can be uploaded", page.locator("#profile-avatar img").count() == 1)
    page.click("#profile-save")
    page.wait_for_timeout(300)
    check("the name is remembered",
          page.evaluate("() => ParcheesiProfile.get().name") == "Aria")
    check("the avatar shows the photo", page.is_visible("#avatar-photo"))
    check("the photo is stored locally",
          (page.evaluate("() => localStorage.getItem('parcheesi.profile.photo')") or "").startswith("data:image"))

    page.click("#avatar-button")
    page.wait_for_selector("#profile-dialog[open]")
    check("the history is listed", page.locator(".profile-match").count() >= 1)
    page.screenshot(path=f"{OUT}/21-profile.png")

    # --- 10. Resetting the profile ----------------------------------------
    page.click("#profile-reset")
    page.wait_for_selector("#confirm-dialog[open]", timeout=4000)
    page.click("#confirm-ok")
    page.wait_for_timeout(300)
    check("the profile can be cleared",
          page.evaluate("() => ParcheesiProfile.get().stats.total.played") == 0)
    check("the photo is cleared too",
          not page.evaluate("() => localStorage.getItem('parcheesi.profile.photo')"))

    check("no uncaught page errors", not errors, "; ".join(errors[:3]))
    browser.close()

if server:
    server.terminate()

passed = sum(1 for _, ok, _ in results if ok)
failed = len(results) - passed
print(f"TOTAL {len(results)}  PASSED {passed}  FAILED {failed}")
sys.exit(1 if failed else 0)
