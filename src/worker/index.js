import "../engine/ludo.js";
import "../voice/ice.js";
import "../voice/protocol.js";

const ENGINE = globalThis.LudoEngine;
const ICE = globalThis.ParcheesiIce;
const VOICE = globalThis.ParcheesiVoiceProtocol;
const HUB_NAME = "global-room-hub";
const TTL_MS = 24 * 60 * 60 * 1000;
const GRACE_MS = 120 * 1000;
// Unambiguous alphabet: no I, L, O, 0 or 1, so codes can be read aloud without confusion.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomToken(bytes = 24) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let binary = "";
  for (const value of data) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function inviteCode(length = 8) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let code = "";
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}
function normalizeInvite(value) {
  return String(value || "").toUpperCase().split("").filter((ch) => CODE_ALPHABET.includes(ch)).join("");
}
function cleanName(value) {
  // Strip control characters and angle brackets without relying on literal escapes.
  const printable = String(value || "Player").split("").filter((ch) => {
    const code = ch.codePointAt(0);
    return code > 31 && code !== 127;
  }).join("");
  return printable.replace(/[<>]/g, "").trim().slice(0, 20) || "Player";
}
function safeRoom(room) {
  return {
    invite: room.invite, status: room.status, host: room.host, createdAt: room.createdAt, voiceEnabled: room.voiceEnabled !== false,
    players: room.players.map((p) => ({
      id: p.id, name: p.name, color: p.color, ready: p.ready,
      connected: p.connected, host: p.id === room.host
    })),
    state: room.state, sequence: room.sequence
  };
}
function peerFor(ws) {
  return {
    ws,
    send(value) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(value)); } catch {}
      }
    },
    close(code = 1000) {
      try { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code); } catch {}
    }
  };
}

export class RoomHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.rooms = new Map();
    this.eventRates = new WeakMap();
    this.queue = Promise.resolve();
    this.ready = this.restore();
  }
  async restore() {
    const stored = await this.ctx.storage.list({ prefix: "room:" });
    const liveSeats = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment();
      if (attachment?.invite && attachment?.playerId) {
        liveSeats.add(attachment.invite + ":" + attachment.playerId);
      }
    }
    for (const [key, room] of stored) {
      room.peers = new Map();
      for (const player of room.players) {
        player.connected = liveSeats.has(room.invite + ":" + player.id);
        if (!player.connected && !player.disconnectedAt) player.disconnectedAt = Date.now();
        if (player.connected) player.disconnectedAt = null;
      }
      this.rooms.set(key.slice(5), room);
    }
    await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
  }
  async persist(room) {
    const copy = { ...room, peers: undefined };
    await this.ctx.storage.put("room:" + room.invite, copy);
  }
  connectedSockets() { return this.ctx.getWebSockets(); }
  socketForPlayer(room, playerId) {
    for (const ws of this.connectedSockets()) {
      const attachment = ws.deserializeAttachment();
      if (attachment?.invite === room.invite && attachment?.playerId === playerId) return ws;
    }
    return null;
  }
  emit(room, message) {
    for (const player of room.players) {
      const ws = this.socketForPlayer(room, player.id);
      if (ws) peerFor(ws).send({ sequence: room.sequence, ...message });
    }
  }
  snapshot(room) { this.emit(room, { type: "room.snapshot", room: safeRoom(room) }); }
  migrateHost(room) {
    const current = room.players.find((p) => p.id === room.host);
    if (current?.connected) return;
    const successor = room.players.find((p) => p.connected) || room.players[0];
    if (successor) room.host = successor.id;
  }
  attach(room, player, ws) {
    const old = this.socketForPlayer(room, player.id);
    if (old && old !== ws) { try { old.close(4001, "Seat reconnected elsewhere"); } catch {} }
    const priorAttachment = ws.deserializeAttachment() || {};
    ws.serializeAttachment({ ...priorAttachment, invite: room.invite, playerId: player.id });
    player.connected = true;
    player.disconnectedAt = null;
  }
  async createRoom(peer, name, voiceEnabled = true) {
    const invite = inviteCode(8);
    const playerToken = randomToken(24);
    const id = crypto.randomUUID();
    const room = {
      id, invite, host: id, status: "lobby", createdAt: Date.now(), updatedAt: Date.now(), voiceEnabled: voiceEnabled !== false,
      players: [{ id, token: playerToken, name: cleanName(name), color: "red", ready: true, connected: true, disconnectedAt: null }],
      state: null, sequence: 0
    };
    this.rooms.set(invite, room);
    this.attach(room, room.players[0], peer.ws);
    await this.persist(room);
    peer.send({ type: "room.created", sequence: room.sequence, invite, playerToken, playerColor: "red", room: safeRoom(room) });
  }
  async joinRoom(peer, invite, playerToken, name) {
    const code = normalizeInvite(invite);
    const room = this.rooms.get(code);
    if (!room || Date.now() - room.createdAt > TTL_MS) throw new Error("Invitation is invalid or expired");
    let player = room.players.find((p) => p.token === playerToken);
    if (!player) {
      if (room.status !== "lobby") throw new Error("Game already started; use your original seat link to reconnect");
      if (room.players.length >= 4) throw new Error("Room is full");
      player = {
        id: crypto.randomUUID(), token: randomToken(24), name: cleanName(name),
        color: ["red", "green", "yellow", "blue"][room.players.length],
        ready: false, connected: true, disconnectedAt: null
      };
      room.players.push(player);
    }
    this.attach(room, player, peer.ws);
    this.migrateHost(room);
    room.sequence++;
    room.updatedAt = Date.now();
    await this.persist(room);
    peer.send({ type: "room.joined", sequence: room.sequence, invite: room.invite, playerToken: player.token, playerColor: player.color, room: safeRoom(room) });
    this.snapshot(room);
  }
  roomContext(ws) {
    const attachment = ws.deserializeAttachment();
    if (!attachment?.invite || !attachment?.playerId) throw new Error("Join a room first");
    const room = this.rooms.get(attachment.invite);
    const player = room?.players.find((p) => p.id === attachment.playerId);
    if (!room || !player) throw new Error("Room membership is no longer valid");
    return { room, player };
  }
  async handle(ws, msg) {
    const peer = peerFor(ws);
    try {
      const now = Date.now();
      const rate = this.eventRates.get(ws) || { start: now, count: 0, voiceStart: now, voiceCount: 0 };
      if (now - rate.start > 10000) { rate.start = now; rate.count = 0; }
      if (now - rate.voiceStart > 10000) { rate.voiceStart = now; rate.voiceCount = 0; }
      if (msg.type === "voice.signal") {
        // A handshake carries a burst of network candidates, so it gets its own budget.
        rate.voiceCount++;
        if (rate.voiceCount > 240) throw new Error("Too much voice traffic. Please slow down.");
      } else {
        rate.count++;
        if (rate.count > 50) throw new Error("Too many actions. Please slow down.");
      }
      this.eventRates.set(ws, rate);
      if (!msg || typeof msg.type !== "string") throw new Error("Invalid message");
      if (msg.type === "room.create") return await this.createRoom(peer, msg.name, msg.voiceEnabled);
      if (msg.type === "room.join") return await this.joinRoom(peer, msg.invite, msg.playerToken, msg.name);

      const { room, player } = this.roomContext(ws);
      if (msg.type === "lobby.ready") {
        if (room.status !== "lobby") throw new Error("Lobby is closed");
        player.ready = !!msg.ready;
        room.sequence++;
      } else if (msg.type === "lobby.rename") {
        const next = cleanName(msg.name);
        if (!next) throw new Error("Name cannot be empty");
        player.name = next;
        room.sequence++;
      } else if (msg.type === "lobby.kick") {
        if (player.id !== room.host) throw new Error("Only the host can remove a player");
        const target = room.players.find((p) => p.id === msg.playerId);
        if (!target) throw new Error("That player is not at this table");
        if (target.id === room.host) throw new Error("The host cannot be removed");
        room.players = room.players.filter((p) => p.id !== target.id);
        const targetSocket = this.socketForPlayer(room, target.id);
        if (targetSocket) {
          peerFor(targetSocket).send({ type: "room.kicked" });
          try { targetSocket.close(1000, "Removed from room"); } catch {}
        }
        room.sequence++;
      } else if (msg.type === "lobby.start") {
        if (player.id !== room.host) throw new Error("Only the host can start the game");
        if (room.status !== "lobby") throw new Error("Game already started");
        if (room.players.length < 2) throw new Error("At least two players are required");
        if (room.players.some((p) => !p.ready)) throw new Error("Everyone must be ready");
        room.state = ENGINE.initialState({
          players: room.players.map((p) => p.color),
          names: Object.fromEntries(room.players.map((p) => [p.color, p.name]))
        });
        room.status = "playing";
        room.sequence++;
        this.emit(room, { type: "game.started", sequence: room.sequence, room: safeRoom(room) });
        return;
      } else if (msg.type === "game.roll") {
        if (room.status !== "playing") throw new Error("Game is not active");
        if (room.state.players[room.state.currentPlayer].id !== player.color) throw new Error("It is not your turn");
        const roll = crypto.getRandomValues(new Uint32Array(1))[0] % 6 + 1;
        room.state = ENGINE.applyRoll(room.state, roll);
        room.sequence++;
        this.emit(room, { type: "game.update", sequence: room.sequence, room: safeRoom(room), event: { type: "roll", player: player.color, roll } });
        return;
      } else if (msg.type === "game.move") {
        if (room.status !== "playing") throw new Error("Game is not active");
        if (room.state.players[room.state.currentPlayer].id !== player.color) throw new Error("It is not your turn");
        if (!Number.isInteger(msg.token) || msg.token < 0 || msg.token > 3) throw new Error("Invalid token");
        room.state = ENGINE.applyMove(room.state, msg.token);
        room.sequence++;
        if (room.state.status === "finished") room.status = "finished";
        this.emit(room, { type: "game.update", sequence: room.sequence, room: safeRoom(room), event: { type: "move", player: player.color, token: msg.token } });
        return;
      } else if (msg.type === "game.rematch") {
        if (room.status !== "finished") throw new Error("The game is still running");
        room.state = null;
        room.status = "lobby";
        for (const seated of room.players) seated.ready = false;
        room.sequence++;
      } else if (msg.type === "game.state") {
        peer.send({ type: "room.snapshot", sequence: room.sequence, room: safeRoom(room) });
        return;
      } else if (msg.type === "room.leave") {
        // An explicit leave releases the seat. A dropped socket keeps the seat for the grace period instead.
        room.players = room.players.filter((p) => p.id !== player.id);
        if (room.state) ENGINE.removePlayer(room.state, player.color);
        room.sequence++;
        if (!room.players.length) {
          this.rooms.delete(room.invite);
          await this.ctx.storage.delete("room:" + room.invite);
        } else {
          this.migrateHost(room);
          room.updatedAt = Date.now();
          await this.persist(room);
          this.snapshot(room);
        }
        try { ws.close(1000, "Left room"); } catch {}
        return;
      } else if (msg.type === "voice.signal") {
        // The server only carries the handshake. The audio never touches it.
        if (room.voiceEnabled === false) throw new Error("Voice chat is disabled for this room");
        const signal = VOICE.parseVoiceSignal(msg, room.players.map((p) => p.color));
        if (signal.to) {
          const target = room.players.find((p) => p.color === signal.to);
          const targetSocket = target ? this.socketForPlayer(room, target.id) : null;
          if (targetSocket) peerFor(targetSocket).send({ type: "voice.signal", kind: signal.kind, from: player.color, data: signal.data });
        } else {
          for (const seated of room.players) {
            if (seated.id === player.id) continue;
            const socket = this.socketForPlayer(room, seated.id);
            if (socket) peerFor(socket).send({ type: "voice.signal", kind: signal.kind, from: player.color, data: signal.data });
          }
        }
        return;
      } else if (msg.type === "chat.send") {
        const body = String(msg.text || "").trim().slice(0, 240);
        if (!body) return;
        this.emit(room, { type: "chat.message", player: player.name, color: player.color, text: body, sequence: ++room.sequence });
        return;
      } else if (msg.type === "room.close") {
        if (player.id !== room.host) throw new Error("Only the host can close the room");
        this.emit(room, { type: "room.closed" });
        for (const socket of this.connectedSockets()) {
          if (socket.deserializeAttachment()?.invite === room.invite) { try { socket.close(1000, "Room closed"); } catch {} }
        }
        this.rooms.delete(room.invite);
        await this.ctx.storage.delete("room:" + room.invite);
        return;
      } else {
        throw new Error("Unknown action");
      }
      room.updatedAt = Date.now();
      await this.persist(room);
      this.snapshot(room);
    } catch (error) {
      peer.send({ type: "room.error", error: error?.message || "Request failed" });
    }
  }
  async disconnect(ws) {
    const attachment = ws.deserializeAttachment();
    if (!attachment?.invite) return;
    const room = this.rooms.get(attachment.invite);
    const player = room?.players.find((p) => p.id === attachment.playerId);
    if (!room || !player) return;
    const replacement = this.socketForPlayer(room, player.id);
    if (replacement && replacement !== ws) return;
    player.connected = false;
    player.disconnectedAt = Date.now();
    this.migrateHost(room);
    room.sequence++;
    room.updatedAt = Date.now();
    await this.persist(room);
    this.snapshot(room);
  }
  async cleanup() {
    const now = Date.now();
    for (const [invite, room] of this.rooms) {
      const expired = now - room.createdAt > TTL_MS;
      const abandoned = room.players.every((p) => !p.connected && p.disconnectedAt && now - p.disconnectedAt > GRACE_MS) && room.status !== "playing";
      if (expired || abandoned) {
        for (const ws of this.connectedSockets()) {
          if (ws.deserializeAttachment()?.invite === invite) { try { ws.close(1000, "Room expired"); } catch {} }
        }
        this.rooms.delete(invite);
        await this.ctx.storage.delete("room:" + invite);
      }
    }
  }
  async fetch(request) {
    await this.ready;
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const origin = request.headers.get("Origin");
    if (origin) {
      try { if (new URL(origin).host !== new URL(request.url).host) return new Response("Origin not allowed", { status: 403 }); }
      catch { return new Response("Invalid origin", { status: 403 }); }
    }
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const count = this.connectedSockets().filter((ws) => ws.deserializeAttachment()?.ip === ip).length;
    if (count >= 12) return new Response("Connection limit reached", { status: 429 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ ip });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  enqueue(task) {
    this.queue = this.queue.then(task).catch((error) => {
      console.error("RoomHub task failed", error);
    });
    return this.queue;
  }
  async webSocketMessage(ws, message) {
    await this.ready;
    return this.enqueue(async () => {
      try {
        if (typeof message !== "string") throw new Error("Only JSON text messages are supported");
        await this.handle(ws, JSON.parse(message));
      } catch (error) {
        peerFor(ws).send({ type: "room.error", error: error?.message || "Malformed message" });
      }
    });
  }
  async webSocketClose(ws) {
    await this.ready;
    return this.enqueue(() => this.disconnect(ws));
  }
  async webSocketError(ws) {
    await this.ready;
    return this.enqueue(() => this.disconnect(ws));
  }
  async alarm() {
    await this.ready;
    return this.enqueue(async () => {
      await this.cleanup();
      await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "parcheesi-cloudflare", time: Date.now() }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/config") {
      return Response.json({ publicUrl: url.origin }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/voice/ice") {
      // STUN is free and always available. The relay is added when a TURN key
      // is configured as a Worker secret.
      const config = await ICE.iceServers(env);
      return Response.json(config, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      const id = env.ROOM_HUB.idFromName(HUB_NAME);
      return env.ROOM_HUB.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
