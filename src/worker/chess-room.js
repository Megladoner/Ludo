import core from "../chess/core.js";

// One Durable Object per chess room. The object is the only place a game is decided:
// it validates every move with chess.js, keeps the clocks, and wakes itself with an
// alarm when a clock runs out or a first move is overdue. Sockets use the hibernation
// API, so a room that is idle costs nothing and survives eviction: the room itself is
// stored in Durable Object storage after every change.

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MAX_MESSAGE = 40000;
const MAX_SOCKETS_PER_PLAYER = 4;

export function randomToken(bytes = 24) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let binary = "";
  for (const value of data) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
export function chessCode(length = 8) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let code = "";
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}
export function normalizeCode(value) {
  return String(value || "").toUpperCase().split("").filter((ch) => CODE_ALPHABET.includes(ch)).join("");
}

function send(ws, value) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(value)); } catch {}
  }
}
function deps(now, extra) {
  return { now, id: () => crypto.randomUUID(), token: () => randomToken(24), random: () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296, ...extra };
}

export class ChessRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.rates = new WeakMap();
    this.queue = Promise.resolve();
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get("room")) || null;
      if (this.room) this.syncConnections(Date.now());
    });
  }

  /* ------------------------------------------------------------- plumbing -- */

  sockets(playerId) {
    return this.ctx.getWebSockets().filter((ws) => {
      const a = ws.deserializeAttachment();
      return a?.playerId && (playerId ? a.playerId === playerId : true);
    });
  }
  // Rebuilds who is connected from the live sockets (after the object wakes from hibernation).
  syncConnections(now) {
    const live = new Set(this.sockets().map((ws) => ws.deserializeAttachment().playerId));
    for (const p of this.room.players) core.setConnected(this.room, p.id, live.has(p.id), now);
  }
  async save() {
    await this.ctx.storage.put("room", this.room);
    await this.schedule();
  }
  async schedule() {
    if (!this.room) return;
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 50, core.nextWake(this.room)));
  }
  deliver(out) {
    for (const item of out) {
      const targets = item.to === "all" ? this.sockets() : this.sockets(item.to);
      for (const ws of targets) send(ws, item.msg);
    }
  }
  broadcastSnapshot(event) {
    this.room.sequence++;
    this.deliver([{ to: "all", msg: core.snapshotMsg(this.room, Date.now(), event, false) }]);
  }
  async destroy(notify) {
    if (notify) this.deliver([{ to: "all", msg: { type: "room.closed" } }]);
    for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, "Room closed"); } catch {} }
    this.room = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch((error) => { console.error("ChessRoom task failed", error); });
    return run;
  }

  /* ---------------------------------------------------------------- http -- */

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") === "websocket") return this.upgrade(request);
    if (url.pathname === "/init" && request.method === "POST") {
      return this.enqueue(async () => {
        if (this.room) return Response.json({ error: "exists" }, { status: 409 });
        const body = await request.json();
        const now = Date.now();
        this.room = core.createRoom(deps(now, { code: String(body.code) }), body);
        await this.save();
        const host = this.room.players[0];
        return Response.json({ code: this.room.code, playerToken: host.token, playerId: host.id });
      });
    }
    if (url.pathname === "/status") {
      const room = this.room;
      if (!room || core.isExpired(room, Date.now())) return Response.json({ exists: false });
      return Response.json({
        exists: true, status: room.status, players: room.players.length, voice: !!room.voice,
        settings: room.settings, full: room.players.length >= 2,
        joinable: room.players.length < 2 && room.status !== "playing",
      });
    }
    return new Response("Not found", { status: 404 });
  }

  upgrade(request) {
    if (!this.room || core.isExpired(this.room, Date.now())) return new Response("Room not found", { status: 404 });
    const origin = request.headers.get("Origin");
    if (origin) {
      try { if (new URL(origin).host !== new URL(request.url).host) return new Response("Origin not allowed", { status: 403 }); }
      catch { return new Response("Invalid origin", { status: 403 }); }
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ playerId: null });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /* ----------------------------------------------------------- websockets -- */

  async webSocketMessage(ws, message) {
    await this.ready;
    return this.enqueue(async () => {
      try {
        if (typeof message !== "string" || message.length > MAX_MESSAGE) throw new Error("Only small JSON text messages are supported");
        await this.onMessage(ws, JSON.parse(message));
      } catch (error) {
        send(ws, { type: "room.error", error: error?.message || "Malformed message" });
      }
    });
  }

  async onMessage(ws, msg) {
    if (!msg || typeof msg.type !== "string") throw new Error("Invalid message");
    const now = Date.now();
    const voice = msg.type.startsWith("voice.");
    const rate = this.rates.get(ws) || { start: now, count: 0 };
    if (now - rate.start > 10000) { rate.start = now; rate.count = 0; }
    rate.count++;
    this.rates.set(ws, rate);
    if (rate.count > (voice ? 120 : 40)) throw new Error("Too many actions. Please slow down.");
    if (!this.room) throw new Error("This room no longer exists");

    if (msg.type === "room.join") return this.join(ws, msg, now);
    const attachment = ws.deserializeAttachment();
    if (!attachment?.playerId) throw new Error("Join the room first");
    // A clock may have run out while nobody was looking: settle it before acting.
    await this.settle(now);
    const result = core.handle(this.room, attachment.playerId, msg, deps(now));
    if (result.close) {
      this.deliver(result.out);
      return this.destroy(false);
    }
    if (result.persist) await this.save();
    this.deliver(result.out);
    if (msg.type === "room.leave" && this.room) {
      const left = ws.deserializeAttachment();
      if (!this.room.players.some((p) => p.id === left.playerId)) {
        ws.serializeAttachment({ playerId: null });
        try { ws.close(1000, "Left room"); } catch {}
        core.setConnected(this.room, left.playerId, false, now);
      }
    }
  }

  async settle(now) {
    const tick = core.tickRoom(this.room, now);
    if (tick.changed) {
      await this.save();
      this.deliver([{ to: "all", msg: core.snapshotMsg(this.room, now, tick.event, false) }]);
    }
  }

  async join(ws, msg, now) {
    await this.settle(now);
    const room = this.room;
    const { player, created } = core.joinRoom(room, deps(now), msg.playerToken, msg.name);
    if (!created && msg.name && room.status !== "playing") player.name = core.cleanName(msg.name);
    const mine = this.sockets(player.id).filter((s) => s !== ws);
    if (mine.length >= MAX_SOCKETS_PER_PLAYER) { try { mine[0].close(1000, "Too many tabs"); } catch {} }
    ws.serializeAttachment({ playerId: player.id });
    core.setConnected(room, player.id, true, now);
    room.updatedAt = now;
    room.sequence++;
    await this.save();
    send(ws, {
      type: "room.joined", sequence: room.sequence, invite: room.code, playerToken: player.token, playerId: player.id,
      playerColor: player.color, room: core.publicRoom(room, now), chat: room.chat, serverNow: now,
    });
    this.broadcastSnapshot({ type: "presence", player: player.id, connected: true, created });
    await this.save();
  }

  async webSocketClose(ws) { return this.dropped(ws); }
  async webSocketError(ws) { return this.dropped(ws); }
  async dropped(ws) {
    await this.ready;
    return this.enqueue(async () => {
      const playerId = ws.deserializeAttachment()?.playerId;
      if (!playerId || !this.room) return;
      try { ws.serializeAttachment({ playerId: null }); } catch {}
      if (this.sockets(playerId).some((s) => s !== ws)) return;
      const now = Date.now();
      if (core.setConnected(this.room, playerId, false, now)) {
        this.room.updatedAt = now;
        await this.save();
        this.broadcastSnapshot({ type: "presence", player: playerId, connected: false });
      }
    });
  }

  async alarm() {
    await this.ready;
    return this.enqueue(async () => {
      if (!this.room) return;
      const now = Date.now();
      if (core.isExpired(this.room, now)) return this.destroy(true);
      await this.settle(now);
      await this.schedule();
    });
  }
}
