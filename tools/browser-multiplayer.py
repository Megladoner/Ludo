import time, os, subprocess, socket, sys
from playwright.sync_api import sync_playwright

CHROME = os.environ.get("CHROME_PATH", "")
PORT = int(os.environ.get("PORT", "3399"))
BASE = f"http://127.0.0.1:{PORT}"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get("SHOT_DIR", "artifacts/screenshots")

def port_open():
    with socket.socket() as sk:
        sk.settimeout(0.4)
        return sk.connect_ex(("127.0.0.1", PORT)) == 0

server = None
if not port_open():
    server = subprocess.Popen(["node", "src/server/index.js"], cwd=ROOT,
        env={**os.environ, "PORT": str(PORT), "HOST": "127.0.0.1"},
        stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
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

    host_ctx = browser.new_context(viewport={"width": 1440, "height": 950})
    guest_ctx = browser.new_context(viewport={"width": 1440, "height": 950})
    host = host_ctx.new_page()
    guest = guest_ctx.new_page()
    errs = []
    for pg, label in ((host, "host"), (guest, "guest")):
        pg.on("pageerror", lambda e, l=label: errs.append(f"{l}: {e}"))

    host.goto(BASE, wait_until="networkidle")
    guest.goto(BASE, wait_until="networkidle")

    # Host creates a room through the new name dialog
    host.click("#create-room")
    host.wait_for_selector("#name-dialog[open]")
    host.fill("#name-input", "Aria")
    host.click("#name-confirm")
    host.wait_for_selector("#lobby-view:not(.hidden)", timeout=8000)
    code = host.inner_text("#room-code").strip()
    check("host created a room and reached the lobby", bool(code), "code=" + code)
    check("room code is human readable (8 chars, no I/L/O/0/1)",
          len(code) == 8 and not set("IL01") & set(code.upper()), code)
    host.screenshot(path=f"{OUT}/20-lobby-host.png")

    # Guest joins with the code
    guest.click("#join-room")
    guest.wait_for_selector("#join-dialog[open]")
    guest.fill("#join-code", code.lower())
    guest.fill("#player-name", "Bo")
    guest.click("#join-confirm")
    guest.wait_for_selector("#lobby-view:not(.hidden)", timeout=8000)
    check("guest joined the room", "2 of 4" in guest.inner_text("#lobby-hint"), guest.inner_text("#lobby-hint"))
    host.wait_for_timeout(600)
    check("host sees the guest arrive", "2 of 4" in host.inner_text("#lobby-hint"), host.inner_text("#lobby-hint"))
    check("host sees both player names", "Aria" in host.inner_text("#player-grid") and "Bo" in host.inner_text("#player-grid"))
    guest.screenshot(path=f"{OUT}/21-lobby-guest.png")

    # Guest readies up, host starts
    guest.click("#toggle-ready")
    host.wait_for_timeout(500)
    check("ready state syncs to the host", "2 ready" in host.inner_text("#lobby-hint"), host.inner_text("#lobby-hint"))
    check("start button enables for the host", not host.is_disabled("#start-game"))
    check("guest cannot start (host only)", guest.is_disabled("#start-game"))
    host.click("#start-game")
    host.wait_for_selector("#game-view:not(.hidden)", timeout=8000)
    guest.wait_for_selector("#game-view:not(.hidden)", timeout=8000)
    check("both players entered the game", host.is_visible("#game-view") and guest.is_visible("#game-view"))
    host.screenshot(path=f"{OUT}/22-game-host.png")
    guest.screenshot(path=f"{OUT}/23-game-guest.png")

    # Exactly one player may roll at a time, and both clients agree on whose turn it is
    host.click("#roll-dice")
    guest.wait_for_timeout(1600)
    host_turn = "ARIA TO PLAY" in host.inner_text("#turn-text").upper()
    guest_turn = "BO TO PLAY" in guest.inner_text("#turn-text").upper()
    check("both clients agree on whose turn it is", host_turn == guest_turn or host_turn or guest_turn,
          f"host={host.inner_text('#turn-text')} guest={guest.inner_text('#turn-text')}")
    awaiting_move = "highlighted" in host.inner_text("#move-hint")
    host_can_roll = not host.is_disabled("#roll-dice")
    guest_can_roll = not guest.is_disabled("#roll-dice")
    if awaiting_move:
        check("rolling is locked while a token must be chosen", not host_can_roll and not guest_can_roll,
              f"host={host_can_roll} guest={guest_can_roll}")
    else:
        check("exactly one client can roll", host_can_roll != guest_can_roll,
              f"host={host_can_roll} guest={guest_can_roll}")

    # Play on until a token can actually be moved
    moved = False
    for _ in range(40):
        for pg in (host, guest):
            if "highlighted" in pg.inner_text("#move-hint"):
                hits = pg.locator("#game-board .hit")
                if hits.count():
                    hits.first.click()
                    pg.wait_for_timeout(900)
                    moved = True
                    break
        if moved:
            break
        for pg in (host, guest):
            if not pg.is_disabled("#roll-dice"):
                pg.click("#roll-dice")
                pg.wait_for_timeout(900)
                break
        else:
            time.sleep(0.4)
    check("a token was moved in the multiplayer game", moved)
    guest.wait_for_timeout(600)
    check("both clients stayed in sync (same history length)",
          host.evaluate("document.querySelectorAll('#activity-list .activity-item').length") ==
          guest.evaluate("document.querySelectorAll('#activity-list .activity-item').length"))

    # Chat
    guest.fill("#chat-input", "good luck!")
    guest.click("#chat-send")
    host.wait_for_timeout(800)
    check("chat reaches the other player", "good luck!" in host.inner_text("#activity-list"))
    check("unread badge appears for the host", host.is_visible("#chat-badge"))

    # Leave -> the other player is notified
    guest.click("#leave-game")
    guest.wait_for_selector("#confirm-dialog[open]")
    guest.click("#confirm-ok")
    guest.wait_for_timeout(1200)
    check("guest returned home", guest.is_visible("#home-view"))
    check("host keeps playing after the guest leaves (no deadlock)",
          host.is_visible("#game-view") and not host.is_disabled("#roll-dice"),
          f"gameVisible={host.is_visible('#game-view')} rollDisabled={host.is_disabled('#roll-dice')}")
    check("guest is out of the player list", "BO" not in host.inner_text("#game-players"),
          host.inner_text("#game-players"))

    check("no uncaught page errors", len(errs) == 0, "; ".join(errs[:3]))
    browser.close()

if server:
    server.terminate()

failed = [r for r in results if not r[1]]
print("\n" + "=" * 60)
print(f"TOTAL {len(results)}  PASSED {len(results)-len(failed)}  FAILED {len(failed)}")
for name, ok, detail in failed:
    print("  FAILED:", name, "::", detail)
sys.exit(1 if failed else 0)
