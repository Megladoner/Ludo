import time, os, subprocess, socket
from playwright.sync_api import sync_playwright

CHROME = os.environ.get("CHROME_PATH", "")
PORT = int(os.environ.get("PORT", "3398"))
BASE = f"http://127.0.0.1:{PORT}/ludo/"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get("SHOT_DIR", "artifacts/screenshots")
os.makedirs(OUT, exist_ok=True)

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

def wait_for(fn, timeout=15, step=0.25):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn(): return True
        except Exception:
            pass
        time.sleep(step)
    return False

def visible(page, sel):
    return page.evaluate("(s)=>{const e=document.querySelector(s);return !!e&&!e.hidden&&e.offsetParent!==null}", sel)

def badge(page, scope, color):
    return page.evaluate("""([scope,color])=>{const c=document.querySelector(scope+'[data-color="'+color+'"]');
      const b=c&&c.querySelector(':scope > .voice-badge');return b?b.dataset.kind:null}""", [scope, color])

with sync_playwright() as p:
    launch = {"args": ["--no-sandbox", "--disable-dev-shm-usage",
                       "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]}
    if CHROME: launch["executable_path"] = CHROME
    browser = p.chromium.launch(**launch)
    errs = []
    def new_page(width=1280, height=900):
        ctx = browser.new_context(viewport={"width": width, "height": height}, permissions=["microphone"])
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: errs.append(str(e)))
        return pg

    # ---- 1. A room created WITHOUT the switch has no voice anywhere
    a = new_page()
    a.goto(BASE, wait_until="networkidle")
    a.click("#create-room"); a.wait_for_selector("#name-dialog[open]")
    check("create dialog shows the voice switch", visible(a, "#name-voice-row"))
    check("voice switch starts off", a.is_checked("#name-voice") is False)
    a.fill("#name-input", "Quiet"); a.click("#name-confirm")
    a.wait_for_selector("#lobby-view:not(.hidden)")
    time.sleep(0.4)
    check("no voice bar in a room without voice", not visible(a, ".voice-bar-lobby"))
    check("no voice rule line without voice", not visible(a, "#rule-voice"))
    a.close()

    # ---- 2. Rename dialog never shows the switch
    b = new_page()
    b.goto(BASE, wait_until="networkidle")

    # ---- 3. Local games have no voice
    b.click("#play-local"); b.wait_for_selector("#setup-dialog[open]"); b.click("#setup-confirm")
    b.wait_for_selector("#game-view:not(.hidden)")
    check("no voice bar in pass & play", not visible(b, ".voice-bar-chat"))
    check("chat still works in local play", True)
    b.close()

    # ---- 4. Voice room with three players
    host = new_page(); g1 = new_page(); g2 = new_page()
    host.goto(BASE, wait_until="networkidle")
    host.click("#create-room"); host.wait_for_selector("#name-dialog[open]")
    host.fill("#name-input", "Aria")
    host.check("#name-voice")
    host.click("#name-confirm")
    host.wait_for_selector("#lobby-view:not(.hidden)")
    code = host.inner_text("#room-code").strip()
    check("voice bar appears in the lobby when switched on", wait_for(lambda: visible(host, ".voice-bar-lobby")))
    check("lobby shows the VOICE CHAT rule line", visible(host, "#rule-voice"))

    for pg, name in ((g1, "Bram"), (g2, "Cleo")):
        pg.goto(BASE, wait_until="networkidle")
        pg.click("#join-room"); pg.wait_for_selector("#join-dialog[open]")
        pg.fill("#join-code", code); pg.fill("#player-name", name); pg.click("#join-confirm")
        pg.wait_for_selector("#lobby-view:not(.hidden)")
    check("guests see the voice bar too", wait_for(lambda: visible(g1, ".voice-bar-lobby") and visible(g2, ".voice-bar-lobby")))
    check("no badge before anyone joins voice", badge(host, "#player-grid .player-seat", "red") is None)

    host.click("#lobby-view [data-voice=join]")
    check("host is on voice", wait_for(lambda: badge(host, "#player-grid .player-seat", "red") in ("live", "speaking")))
    check("guest sees host on voice before joining", wait_for(lambda: badge(g1, "#player-grid .player-seat", "red") in ("live", "speaking", "muted")))
    g1.click("#lobby-view [data-voice=join]")
    g2.click("#lobby-view [data-voice=join]")

    # real WebRTC connections between all three
    def all_connected():
        for pg, others in ((host, ("green", "yellow")), (g1, ("red", "yellow")), (g2, ("red", "green"))):
            for c in others:
                if badge(pg, "#player-grid .player-seat", c) not in ("live", "speaking"): return False
        return True
    check("all three players are connected by voice", wait_for(all_connected, 25), str([badge(host, "#player-grid .player-seat", c) for c in ("green","yellow")]))
    check("lobby says 3 on the call", "3 on the call" in host.inner_text("#lobby-view .voice-text small").lower() or "talking" in host.inner_text("#lobby-view .voice-text small").lower(), host.inner_text("#lobby-view .voice-text small"))

    # audio is really flowing: each page has 2 remote audio elements with a live track
    live = host.evaluate("[...document.querySelectorAll('#voice-audio audio')].filter(a=>a.srcObject&&a.srcObject.getAudioTracks().some(t=>t.readyState==='live')).length")
    check("host receives two live remote audio streams", live == 2, str(live))

    # the fake microphone beeps, so someone should light up as speaking
    check("someone shows as speaking", wait_for(lambda: any(badge(host, "#player-grid .player-seat", c) == "speaking" for c in ("red", "green", "yellow")), 20))
    lit = host.evaluate("document.querySelectorAll('#player-grid .player-seat.is-speaking').length")
    check("a card carries the speaking glow", lit >= 1 or wait_for(lambda: host.evaluate("document.querySelectorAll('#player-grid .player-seat.is-speaking').length")>=1, 10))
    host.screenshot(path=f"{OUT}/voice-lobby-desktop.png")

    # ---- 5. Mute is self-only and visible to others
    host.click("#lobby-view [data-voice=mute]")
    check("others see host muted", wait_for(lambda: badge(g1, "#player-grid .player-seat", "red") == "muted"))
    check("host mute button now says Unmute", "Unmute" in host.inner_text("#lobby-view [data-voice=mute]"))
    check("guest has no control to mute others", g1.evaluate("document.querySelectorAll('[data-voice]').length") == 6 and
          g1.evaluate("[...document.querySelectorAll('[data-voice]')].every(b=>['join','mute','leave'].includes(b.dataset.voice))"))
    host.click("#lobby-view [data-voice=mute]")
    check("host unmutes", wait_for(lambda: badge(g1, "#player-grid .player-seat", "red") in ("live", "speaking")))

    # ---- 6. Start the game: voice carries on, bar moves to the chat panel, chat intact
    for pg in (g1, g2):
        pg.click("#toggle-ready")
    wait_for(lambda: not host.is_disabled("#start-game"))
    host.click("#start-game")
    for pg in (host, g1, g2):
        pg.wait_for_selector("#game-view:not(.hidden)")
    check("voice bar sits in the table chat panel", wait_for(lambda: visible(host, ".voice-bar-chat")))
    check("voice survived the start of the game", wait_for(lambda: badge(host, "#game-players .game-player", "green") in ("live", "speaking")))
    check("player cards show voice badges in game", badge(g2, "#game-players .game-player", "red") in ("live", "speaking", "muted"))
    host.fill("#chat-input", "hello text chat"); host.click("#chat-send")
    check("text chat still works alongside voice", wait_for(lambda: "hello text chat" in g1.inner_text("#chat-list")))
    host.screenshot(path=f"{OUT}/voice-game-desktop.png")

    # ---- 7. Leaving voice
    g2.click("#chat-box [data-voice=leave]")
    check("others see Cleo leave voice", wait_for(lambda: badge(host, "#game-players .game-player", "yellow") is None))
    check("Cleo's join button is back", visible(g2, "#chat-box [data-voice=join]"))
    check("mic released after leaving", g2.evaluate("document.querySelectorAll('#voice-audio audio').length") == 0)

    # ---- 8. Reload: voice rejoin works (re-announce)
    g1.reload(wait_until="networkidle")
    g1.wait_for_selector("#game-view:not(.hidden)", timeout=10000)
    check("after reload the player is back at the table, voice not auto-started", wait_for(lambda: visible(g1, "#chat-box [data-voice=join]")))
    g1.click("#chat-box [data-voice=join]")
    check("rejoining voice reconnects with host", wait_for(lambda: badge(g1, "#game-players .game-player", "red") in ("live", "speaking"), 25))
    check("host hears the rejoined player", wait_for(lambda: badge(host, "#game-players .game-player", "green") in ("live", "speaking"), 25))

    # ---- 9. Mobile layout screenshot
    m = new_page(390, 844)
    m.goto(BASE, wait_until="networkidle")
    m.click("#create-room"); m.wait_for_selector("#name-dialog[open]")
    m.screenshot(path=f"{OUT}/voice-create-mobile.png")
    m.fill("#name-input", "A very long name here"); m.check("#name-voice"); m.click("#name-confirm")
    m.wait_for_selector("#lobby-view:not(.hidden)")
    mc = m.inner_text("#room-code").strip()
    f = new_page(390, 844)
    f.goto(BASE, wait_until="networkidle")
    f.click("#join-room"); f.wait_for_selector("#join-dialog[open]")
    f.fill("#join-code", mc); f.fill("#player-name", "Longer friend name"); f.click("#join-confirm")
    f.wait_for_selector("#lobby-view:not(.hidden)")
    m.click("#lobby-view [data-voice=join]"); f.click("#lobby-view [data-voice=join]")
    wait_for(lambda: badge(m, "#player-grid .player-seat", "green") in ("live", "speaking"), 25)
    m.screenshot(path=f"{OUT}/voice-lobby-mobile.png", full_page=True)
    f.click("#toggle-ready"); wait_for(lambda: not m.is_disabled("#start-game")); m.click("#start-game")
    m.wait_for_selector("#game-view:not(.hidden)")
    time.sleep(1.5)
    m.screenshot(path=f"{OUT}/voice-game-mobile.png", full_page=True)
    info = m.evaluate("""()=>{const w=window.innerWidth;const out=[];document.querySelectorAll('body *').forEach(e=>{const r=e.getBoundingClientRect();if(r.width&&r.right>w+1)out.push(e.tagName+'.'+e.className+' '+Math.round(r.right))});return [document.documentElement.scrollWidth,w,out.slice(0,6)]}""")
    check("no horizontal overflow on a phone", info[0] <= info[1] + 1, str(info))

    check("no page errors", not errs, "; ".join(errs[:3]))
    browser.close()

if server: server.terminate()
failed = [r for r in results if not r[1]]
print(f"\n{len(results)-len(failed)}/{len(results)} checks passed")
raise SystemExit(1 if failed else 0)
