"""Browser checks for voice chat.

Two real browsers, a real server, a real WebSocket and a real WebRTC peer
connection. Chromium is launched with a fake microphone so the audio path can
be exercised without a device or a permission prompt.

    python3 tools/browser-voice.py
"""
import os
import subprocess
import sys
import time
import socket

from playwright.sync_api import sync_playwright

CHROME = os.environ.get("CHROME_PATH", "")
PORT = int(os.environ.get("PORT", "3403"))
BASE = f"http://127.0.0.1:{PORT}"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get("SHOT_DIR", os.path.join(ROOT, "artifacts", "screenshots"))
os.makedirs(OUT, exist_ok=True)

# A synthetic microphone, and no permission prompt to click.
FAKE_MEDIA = [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
]


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

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("PASS  " if ok else "FAIL  ") + name + ((" :: " + detail) if detail else ""), flush=True)


def wait_for(page, expression, timeout=20000, interval=250):
    """Wait for a page expression to become truthy."""
    deadline = time.time() + timeout / 1000
    last = None
    while time.time() < deadline:
        last = page.evaluate(expression)
        if last:
            return last
        page.wait_for_timeout(interval)
    return last


with sync_playwright() as p:
    launch = {"args": ["--no-sandbox", "--disable-dev-shm-usage"] + FAKE_MEDIA}
    if CHROME:
        launch["executable_path"] = CHROME
    browser = p.chromium.launch(**launch)
    host_ctx = browser.new_context(viewport={"width": 1440, "height": 950}, permissions=["microphone"])
    guest_ctx = browser.new_context(viewport={"width": 1440, "height": 950}, permissions=["microphone"])
    host = host_ctx.new_page()
    guest = guest_ctx.new_page()
    errors = []
    for pg, label in ((host, "host"), (guest, "guest")):
        pg.on("pageerror", lambda e, l=label: errors.append(f"{l}: {e}"))
        pg.on("console", lambda m, l=label: errors.append(f"{l}: console.{m.type}: {m.text}") if m.type == "error" else None)

    host.goto(BASE, wait_until="networkidle")
    guest.goto(BASE, wait_until="networkidle")

    # --- 1. The ICE endpoint answers ---------------------------------------
    ice = host.evaluate("""async () => {
      const response = await fetch('/api/voice/ice');
      return { status: response.status, body: await response.json() };
    }""")
    check("the voice endpoint answers", ice["status"] == 200, str(ice["status"]))
    check("the table is given ice servers",
          bool(ice["body"].get("iceServers")) and
          all(str(u).startswith(("stun:", "turn:")) for s in ice["body"]["iceServers"] for u in (s["urls"] if isinstance(s["urls"], list) else [s["urls"]])),
          str(ice["body"])[:120])

    # --- 2. A table of two --------------------------------------------------
    host.click("#create-room")
    host.wait_for_selector("#name-dialog[open]")
    host.fill("#name-input", "Aria")
    host.click("#name-confirm")
    host.wait_for_selector("#lobby-view:not(.hidden)", timeout=10000)
    code = host.inner_text("#room-code").strip()
    check("a room was opened", bool(code), "code=" + code)

    guest.click("#join-room")
    guest.wait_for_selector("#join-dialog[open]")
    guest.fill("#join-code", code.lower())
    guest.fill("#player-name", "Bo")
    guest.click("#join-confirm")
    guest.wait_for_selector("#lobby-view:not(.hidden)", timeout=10000)
    check("the second player joined", "2 of 4" in guest.inner_text("#lobby-hint"), guest.inner_text("#lobby-hint"))

    # --- 3. The microphone is off until it is asked for ----------------------
    check("the microphone button appears at a table", host.is_visible("#voice-toggle"))
    check("the microphone starts off",
          host.evaluate("() => document.getElementById('voice-toggle').classList.contains('is-live')") is False)
    check("nobody is talking yet",
          host.evaluate("() => Object.values(voice.voiceStatus ? {} : {}).length") == 0)

    host.click("#voice-toggle")
    guest.wait_for_timeout(300)
    connected = wait_for(host, "() => voice.active === true", 8000)
    check("the microphone opens when it is asked for", bool(connected))
    check("the button shows the microphone is live",
          host.evaluate("() => document.getElementById('voice-toggle').classList.contains('is-live')") is True)

    # --- 4. A real peer connection between the two browsers -----------------
    guest.click("#voice-toggle")
    wait_for(guest, "() => voice.active === true", 8000)

    states = wait_for(host, """() => {
      const peers = Array.from(voice.peers.values());
      if (!peers.length) return null;
      if (!peers.every((p) => p.pc.connectionState === 'connected' || p.pc.connectionState === 'completed')) return null;
      return peers.map((p) => p.pc.connectionState);
    }""", 25000)
    check("the two browsers hold a live peer connection", bool(states), str(states))

    remote_track = wait_for(host, """() => {
      const peer = Array.from(voice.peers.values())[0];
      return peer && peer.remoteTrack ? { kind: peer.remoteTrack.kind, muted: peer.remoteTrack.muted } : null;
    }""", 15000)
    check("the far end receives an audio track",
          bool(remote_track) and remote_track["kind"] == "audio", str(remote_track))

    check("the far end hears something",
          bool(remote_track) and remote_track["muted"] is False, str(remote_track))

    # --- 5. Speaking is detected -------------------------------------------
    loud = wait_for(host, """() => {
      const peer = Array.from(voice.peers.values())[0];
      return peer && peer.remoteTrack && !peer.remoteTrack.muted;
    }""", 12000)
    check("the remote track is not silent", bool(loud))

    levels = wait_for(host, """() => {
      const level = voice.levels.get('green');
      return level ? level.rms : null;
    }""", 12000)
    check("the far end is metered", levels is not None and levels > 0, str(levels))

    speaking = wait_for(host, "() => voice.speaking('green')", 12000)
    check("speaking is spotted on the far end", bool(speaking), str(speaking))
    check("the seat marker shows who is speaking",
          host.evaluate("() => !!document.querySelector('.voice-badge.is-speaking, .voice-badge.is-live')"))

    # --- 6. Muting stops the sound ------------------------------------------
    guest.click("#voice-toggle")
    guest.wait_for_timeout(1200)
    muted = wait_for(host, """() => {
      const peer = Array.from(voice.peers.values())[0];
      return peer ? peer.remoteMuted : null;
    }""", 12000)
    check("muting on the far end reaches the near end", muted is True, str(muted))
    check("the seat marker shows the far end as muted",
          host.evaluate("() => !!document.querySelector('.voice-badge.is-muted')"))
    check("the far end button shows the microphone is muted",
          guest.evaluate("() => document.getElementById('voice-toggle').classList.contains('is-muted')") is True)

    # Push to talk reopens the microphone without leaving the table.
    guest.evaluate("() => voice.setTalking(true)")
    guest.wait_for_timeout(1500)
    reopened = wait_for(host, """() => {
      const peer = Array.from(voice.peers.values())[0];
      return peer ? peer.remoteMuted : null;
    }""", 12000)
    check("push to talk reopens the microphone", reopened is False, str(reopened))
    guest.evaluate("() => voice.setTalking(false)")

    # --- 7. The line closes when the voice does -----------------------------
    guest.evaluate("() => voice.disable()")
    guest.wait_for_timeout(1500)
    closed = wait_for(host, """() => {
      const peers = Array.from(voice.peers.values());
      return peers.length === 0 || peers.every((p) => p.pc.connectionState === 'closed' || p.pc.connectionState === 'failed');
    }""", 12000)
    check("leaving the voice closes the line", bool(closed))
    check("the seat marker goes quiet when a player leaves the voice",
          host.evaluate("() => !!document.querySelector('.voice-badge.is-off')"))
    check("the far end button shows the microphone is off",
          guest.evaluate("() => document.getElementById('voice-toggle').classList.contains('is-live')") is False)

    # --- 8. The game still plays with voice in the room ---------------------
    guest.click("#toggle-ready")
    host.wait_for_timeout(600)
    host.click("#start-game")
    host.wait_for_selector("#game-view:not(.hidden)", timeout=10000)
    guest.wait_for_selector("#game-view:not(.hidden)", timeout=10000)
    check("the table still starts a game", host.is_visible("#game-view"))
    check("the seat markers sit on the players",
          host.locator("#game-players .voice-badge").count() == 2,
          str(host.locator("#game-players .voice-badge").count()))

    host.click("#voice-toggle")
    host.wait_for_timeout(800)
    check("the microphone can be opened during the game",
          host.evaluate("() => voice.active === true"))
    host.screenshot(path=f"{OUT}/70-voice-game.png")
    guest.screenshot(path=f"{OUT}/71-voice-guest.png")

    check("no uncaught page errors", not errors, "; ".join(errors[:3]))
    browser.close()

if server:
    server.terminate()

passed = sum(1 for _, ok, _ in results if ok)
failed = len(results) - passed
print(f"TOTAL {len(results)}  PASSED {passed}  FAILED {failed}")
sys.exit(1 if failed else 0)
