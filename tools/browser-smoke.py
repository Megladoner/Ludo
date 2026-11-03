import subprocess, time, os, sys, json
from playwright.sync_api import sync_playwright

CHROME = os.environ.get("CHROME_PATH", "")
PORT = int(os.environ.get("PORT", "3399"))
BASE = f"http://127.0.0.1:{PORT}"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get("SHOT_DIR", "artifacts/screenshots")
os.makedirs(OUT, exist_ok=True)

import socket
def port_open():
    with socket.socket() as sk:
        sk.settimeout(0.4)
        return sk.connect_ex(("127.0.0.1", PORT)) == 0

server = None
if not port_open():
    server = subprocess.Popen(
        ["node", "src/server/index.js"],
        cwd=ROOT,
        env={**os.environ, "PORT": str(PORT), "HOST": "127.0.0.1"},
        stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
    )
    time.sleep(1.5)

results = []
def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("PASS  " if ok else "FAIL  ") + name + ((" :: " + detail) if detail else ""), flush=True)

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
    page.screenshot(path=f"{OUT}/01-home.png")

    # --- 1. Name dialog replaces prompt() --------------------------------
    page.click("#create-room")
    page.wait_for_selector("#name-dialog[open]", timeout=4000)
    check("name dialog opens (no native prompt)", page.is_visible("#name-dialog"))
    check("name dialog is pre-filled from storage", page.input_value("#name-input") != "")
    page.fill("#name-input", "Aria")
    check("character counter updates", page.inner_text("#name-count") == "4")
    page.screenshot(path=f"{OUT}/02-name-dialog.png")
    # Cancel must abort cleanly
    page.click("#name-dialog .modal-close")
    page.wait_for_timeout(200)
    check("cancelling the name dialog returns home", page.is_visible("#home-view") and not page.is_visible("#name-dialog"))

    # --- 2. Pass & play setup dialog -------------------------------------
    page.click("#play-local")
    page.wait_for_selector("#setup-dialog[open]", timeout=4000)
    check("setup dialog opens (no native prompt)", page.is_visible("#setup-dialog"))
    check("player count options rendered", page.locator(".seat-option").count() == 3)
    page.click('.seat-option[data-count="2"]')
    check("seat option reflects selection", page.get_attribute('.seat-option[data-count="2"]', "aria-checked") == "true")
    check("two name rows for a two-player table", page.locator(".setup-name").count() == 2)
    page.screenshot(path=f"{OUT}/03-setup-dialog.png")
    page.fill('.setup-name input[data-seat="red"]', "Aria")
    page.fill('.setup-name input[data-seat="green"]', "Bo")
    page.click("#setup-confirm")
    page.wait_for_selector("#game-view:not(.hidden)", timeout=4000)
    check("pass & play game starts", page.is_visible("#game-view"))
    check("board rendered with tokens", page.locator("#game-board .token-g").count() == 8)
    page.screenshot(path=f"{OUT}/04-game.png")

    # --- 3. Dice + token movement ----------------------------------------
    page.click("#roll-dice")
    page.wait_for_timeout(900)
    face = page.inner_text("#dice-face")
    check("dice produced a face", face in list("⚀⚁⚂⚃⚄⚅"), face)
    check("turn advanced or awaiting move", page.inner_text("#move-hint") != "")

    # Roll until a token moves. A lone token plays itself, so the board may
    # advance without a click — count the moves, not the taps.
    def moves():
        return page.evaluate("() => ((state.game && state.game.history) || []).filter((h) => h.type === 'move').length")

    moved = False
    seen = moves()
    for _ in range(30):
        if "highlighted" in page.inner_text("#move-hint"):
            hits = page.locator("#game-board .hit")
            if hits.count():
                before = page.locator("#game-board .token-g").count()
                hits.first.click()
                page.wait_for_timeout(700)
                check("token move applied without error", page.locator("#game-board .token-g").count() == before)
        else:
            page.click("#roll-dice")
            page.wait_for_timeout(1000)
        now = moves()
        if now > seen:
            seen = now
            moved = True
            break
    check("a token could be selected and moved", moved)
    page.screenshot(path=f"{OUT}/05-after-move.png")

    # --- 4. Game menu -----------------------------------------------------
    page.click("#game-menu")
    page.wait_for_selector("#menu-dialog[open]", timeout=4000)
    check("game menu opens", page.is_visible("#menu-dialog"))
    page.screenshot(path=f"{OUT}/06-menu.png")
    page.click("#menu-sound")
    check("sound toggle reflects state", page.inner_text("#menu-sound-state") in ("On", "Off"))
    page.click("#menu-leave")
    page.wait_for_selector("#confirm-dialog[open]", timeout=4000)
    check("leave asks for confirmation", page.is_visible("#confirm-dialog"))
    page.screenshot(path=f"{OUT}/07-confirm.png")
    page.click("#confirm-ok")
    page.wait_for_selector("#home-view:not(.hidden)", timeout=4000)
    check("leaving returns home", page.is_visible("#home-view"))

    # --- 5. Play vs AI setup ---------------------------------------------
    page.click("#play-ai")
    page.wait_for_selector("#setup-dialog[open]", timeout=4000)
    check("AI setup shows difficulty", page.is_visible("#setup-ai-block"))
    page.click('#setup-difficulty button[data-difficulty="hard"]')
    check("difficulty selection sticks", page.get_attribute('#setup-difficulty button[data-difficulty="hard"]', "aria-checked") == "true")
    page.screenshot(path=f"{OUT}/08-ai-setup.png")
    page.click("#setup-confirm")
    page.wait_for_selector("#game-view:not(.hidden)", timeout=4000)
    check("AI game starts", page.is_visible("#game-view"))
    page.wait_for_timeout(2500)
    check("AI took its turn", page.inner_text("#move-hint") != "")
    page.screenshot(path=f"{OUT}/09-ai-game.png")

    # --- 6. Join dialog ---------------------------------------------------
    page.click("#leave-game")
    page.wait_for_selector("#confirm-dialog[open]", timeout=4000)
    page.click("#confirm-ok")
    page.wait_for_timeout(300)
    page.click("#join-room")
    page.wait_for_selector("#join-dialog[open]", timeout=4000)
    check("join dialog opens", page.is_visible("#join-dialog"))
    label_text = page.evaluate("""() => {
      const input = document.getElementById('join-code');
      const label = input.closest('label');
      return label ? label.textContent.trim() : null;
    }""")
    check("join code field has an accessible label", bool(label_text) and "INVITATION CODE" in label_text, str(label_text))
    page.fill("#join-code", "abcd-2345")
    page.click("#join-confirm")
    page.wait_for_timeout(1200)
    check("invalid code shows an inline error, dialog stays open",
          page.is_visible("#join-dialog") and page.is_visible("#join-error"),
          page.inner_text("#join-error") if page.is_visible("#join-error") else "no error shown")
    page.screenshot(path=f"{OUT}/10-join-error.png")
    page.click("#join-cancel")
    page.wait_for_timeout(200)

    # --- 7. Settings ------------------------------------------------------
    page.click("#settings-open")
    page.wait_for_selector("#settings-dialog[open]", timeout=4000)
    check("settings dialog opens", page.is_visible("#settings-dialog"))
    page.click('input[name="theme"][value="forest"]', force=True)
    page.wait_for_timeout(250)
    check("theme preview applies live", page.get_attribute("html", "data-theme") == "forest")
    page.screenshot(path=f"{OUT}/11-settings.png")
    page.click("#settings-save")
    page.wait_for_timeout(300)
    check("theme persists after save", page.get_attribute("html", "data-theme") == "forest")
    page.click("#settings-open")
    page.wait_for_selector("#settings-dialog[open]")
    page.click('input[name="theme"][value="noir"]', force=True)
    page.wait_for_timeout(200)
    check("theme switches back to noir", page.get_attribute("html", "data-theme") == "noir")
    page.click("#settings-save")

    # --- 8. Help dialog ---------------------------------------------------
    page.click("#how-to-play")
    page.wait_for_selector("#help-dialog[open]", timeout=4000)
    check("help dialog opens", page.is_visible("#help-dialog"))
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    check("escape closes the help dialog", not page.is_visible("#help-dialog"))

    # --- 9. Mobile layout -------------------------------------------------
    mobile = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = mobile.new_page()
    mp.goto(BASE, wait_until="networkidle")
    mp.screenshot(path=f"{OUT}/12-mobile-home.png")
    mp.click("#play-local")
    mp.wait_for_selector("#setup-dialog[open]", timeout=4000)
    mp.screenshot(path=f"{OUT}/13-mobile-setup.png")
    mp.click("#setup-confirm")
    mp.wait_for_selector("#game-view:not(.hidden)", timeout=4000)
    mp.screenshot(path=f"{OUT}/14-mobile-game.png")
    check("mobile renders the game board", mp.locator("#game-board .token-g").count() == 16)
    mobile.close()

    check("no uncaught page errors", len(errors) == 0, "; ".join(errors[:4]))
    browser.close()

if server:
    server.terminate()
    time.sleep(0.3)

failed = [r for r in results if not r[1]]
print("\n" + "=" * 60)
print(f"TOTAL {len(results)}  PASSED {len(results)-len(failed)}  FAILED {len(failed)}")
for name, ok, detail in failed:
    print("  FAILED:", name, "::", detail)
sys.exit(1 if failed else 0)
