var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// protocol.mjs
var validRoomId = /* @__PURE__ */ __name((value) => typeof value === "string" && /^[a-f0-9]{32}$/.test(value), "validRoomId");
function cleanName(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 40) throw new Error("\u8BF7\u8F93\u5165 1\u201340 \u5B57\u7684\u540D\u5B57");
  return value.trim();
}
__name(cleanName, "cleanName");
function validateMessage(value) {
  if (!value || typeof value !== "object") throw new Error("\u65E0\u6548\u6D88\u606F");
  const { type } = value;
  if (type === "share-start") {
    if (value.sfu && typeof value.sfu === "object") {
      const { sessionId, videoTrackName, audioTrackName } = value.sfu;
      if (typeof sessionId === "string" && sessionId.length <= 128 && typeof videoTrackName === "string" && videoTrackName.length <= 128) {
        return {
          type,
          sfu: {
            sessionId,
            videoTrackName,
            audioTrackName: typeof audioTrackName === "string" && audioTrackName.length <= 128 ? audioTrackName : null
          }
        };
      }
    }
    return { type };
  }
  if (["ping", "renew", "share-stop", "leave", "end"].includes(type)) return { type };
  if (type === "mute" && typeof value.muted === "boolean") return { type, muted: value.muted };
  if (type === "grant-share" && typeof value.target === "string" && value.target.length <= 64 && typeof value.canShare === "boolean") return { type, target: value.target, canShare: value.canShare };
  if (type !== "signal" || typeof value.to !== "string" || value.to.length > 64) throw new Error("\u65E0\u6548\u4FE1\u4EE4");
  if (value.description) {
    const { type: kind, sdp } = value.description;
    if (!["offer", "answer"].includes(kind) || typeof sdp !== "string" || sdp.length > 48e3) throw new Error("\u65E0\u6548 SDP");
    return { type, to: value.to, description: { type: kind, sdp } };
  }
  const c = value.candidate;
  if (c && typeof c.candidate === "string" && c.candidate.length <= 4096 && (c.sdpMid == null || typeof c.sdpMid === "string" && c.sdpMid.length <= 32) && (c.sdpMLineIndex == null || Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 16)) {
    return { type, to: value.to, candidate: { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null, ...typeof c.usernameFragment === "string" && c.usernameFragment.length < 256 ? { usernameFragment: c.usernameFragment } : {} } };
  }
  throw new Error("\u65E0\u6548 ICE");
}
__name(validateMessage, "validateMessage");
function allowedIceServers(servers) {
  if (!Array.isArray(servers)) throw new Error("TURN \u914D\u7F6E\u65E0\u6548");
  const result = servers.flatMap((entry) => {
    const urls = (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).filter((url) => typeof url === "string" && /^(stun|turn|turns):(stun|turn)\.cloudflare\.com:(3478|5349|443)(\?transport=(udp|tcp))?$/.test(url));
    return urls.length ? [{ urls, ...typeof entry.username === "string" ? { username: entry.username } : {}, ...typeof entry.credential === "string" ? { credential: entry.credential } : {} }] : [];
  });
  if (!result.some((s) => s.urls.some((url) => url.startsWith("turn")) && s.username && s.credential)) throw new Error("\u6CA1\u6709\u53EF\u7528\u7684 Cloudflare TURN \u51ED\u636E");
  return result;
}
__name(allowedIceServers, "allowedIceServers");

// index.mjs
var randomId = /* @__PURE__ */ __name(() => [...crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, "0")).join(""), "randomId");
var headers = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS", "access-control-allow-headers": "Content-Type, Authorization", "cache-control": "no-store", "content-type": "application/json" };
var json = /* @__PURE__ */ __name((data, status = 200) => new Response(JSON.stringify(data), { status, headers }), "json");
var failure = /* @__PURE__ */ __name((message, status = 400) => json({ error: message }, status), "failure");
var index_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    // SFU control requests are handled by the authenticated gateway wrapper.
    if (request.method === "POST") {
      const reader = request.body?.getReader();
      const chunks = [];
      let size = 0;
      if (reader) for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2048) {
          await reader.cancel();
          return failure("\u8BF7\u6C42\u8FC7\u5927", 413);
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      request = new Request(request.url, { method: request.method, headers: request.headers, body: bytes });
    }
    if (url.pathname === "/health") return json({ service: "babagan-p2p", version: 1, turnConfigured: Boolean(env.TURN_KEY_ID && env.TURN_API_TOKEN) });
    if (request.method === "POST" && url.pathname === "/rooms") {
      const ip = request.headers.get("cf-connecting-ip") || "local";
      if (env.CREATE_LIMITER && !(await env.CREATE_LIMITER.limit({ key: ip })).success) return failure("\u521B\u5EFA\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5", 429);
      const id = randomId();
      return env.ROOMS.get(env.ROOMS.idFromName(id)).fetch(new Request(`${url.origin}/rooms/${id}/create`, request));
    }
    const match = url.pathname.match(/^\/rooms\/([^/]+)\/(join|ws|ice|leave|end)$/);
    if (!match || !validRoomId(match[1])) return failure("\u623F\u95F4\u4E0D\u5B58\u5728", 404);
    return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
  }
};
var MeetingRoom = class {
  static {
    __name(this, "MeetingRoom");
  }
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.members = {};
    ctx.blockConcurrencyWhile(async () => {
      this.room = await ctx.storage.get("room") || null;
      this.members = await ctx.storage.get("members") || {};
    });
    if (typeof WebSocketRequestResponsePair !== "undefined") ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }
  sockets() {
    return this.ctx.getWebSockets();
  }
  socket(id) {
    return this.sockets().find((s) => s.deserializeAttachment()?.id === id && s.readyState === 1);
  }
  send(socket, data) {
    try {
      socket.send(JSON.stringify(data));
    } catch {
    }
  }
  broadcast(data) {
    for (const socket of this.sockets()) this.send(socket, data);
  }
  roster() {
    return Object.values(this.members).filter((m) => this.socket(m.id)).map(({ id, name, host, muted, canShare, epoch }) => ({ id, name, host, muted, canShare: Boolean(canShare || host), epoch }));
  }
  async save() {
    await this.ctx.storage.put({ room: this.room, members: this.members });
  }
  state() {
    return { type: "roster", peers: this.roster(), sharer: this.room?.sharer || null, sfu: this.room?.sfu || null };
  }
  prune() {
    for (const [id, m] of Object.entries(this.members)) {
      if (m.host) continue;
      if (!this.socket(id) && m.expires < Date.now()) delete this.members[id];
    }
  }
  async body(request) {
    const text = await request.text();
    if (text.length > 2048) throw new Error("\u8BF7\u6C42\u8FC7\u5927");
    return JSON.parse(text);
  }
  authenticate(request) {
    const url = new URL(request.url);
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "") || url.searchParams.get("token");
    if (!token) return null;
    return Object.values(this.members).find((m) => {
      if (m.token !== token) return false;
      if (m.host) return true;
      if (this.socket(m.id) || m.expires > Date.now()) {
        m.expires = Math.max(m.expires, Date.now() + 18e5);
        return true;
      }
      return false;
    });
  }
  async fetch(request) {
    try {
      const url = new URL(request.url);
      const action = url.pathname.split("/").pop();
      if (request.method === "POST" && action === "create") {
        if (this.room) return failure("\u623F\u95F4\u5DF2\u5B58\u5728", 409);
        const body = await this.body(request);
        const name = cleanName(body.name);
        this.room = { id: url.pathname.split("/")[2], expires: Date.now() + 864e5, sharer: null, ended: false };
        const member2 = this.addMember(name, true);
        await this.save();
        await this.ctx.storage.setAlarm(this.room.expires);
        return json({ room: this.room.id, ...member2 });
      }
      if (!this.room || this.room.ended || this.room.expires <= Date.now()) return failure("\u4F1A\u8BAE\u5DF2\u7ED3\u675F\u6216\u4E0D\u5B58\u5728", 410);
      this.prune();
      if (request.method === "POST" && action === "join") {
        const body = await this.body(request);
        const name = cleanName(body.name);
        if (Object.keys(this.members).length >= 5) return failure("\u4F1A\u8BAE\u6700\u591A 5 \u4EBA\uFF1B\u79BB\u7EBF\u5E2D\u4F4D\u4F1A\u5728\u4FDD\u7559\u671F\u540E\u91CA\u653E", 409);
        const member2 = this.addMember(name, false);
        await this.save();
        return json({ room: this.room.id, ...member2 });
      }
      const member = this.authenticate(request);
      if (!member) return failure("\u5165\u4F1A\u51ED\u8BC1\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u52A0\u5165", 401);
      if (action === "ws" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        const pair = new WebSocketPair();
        const old = this.socket(member.id);
        if (old) old.close(4e3, "replaced");
        this.ctx.acceptWebSocket(pair[1]);
        pair[1].serializeAttachment({ id: member.id, window: Date.now(), count: 0 });
        member.epoch = randomId();
        if (!member.host) member.expires = Date.now() + 18e5;
        await this.save();
        this.send(pair[1], { ...this.state(), type: "welcome", id: member.id });
        this.broadcast(this.state());
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      if (request.method === "POST" && action === "ice") {
        if (!member.host) {
          member.expires = Date.now() + 18e5;
          await this.save();
        }
        return await this.ice();
      }
      if (request.method === "POST" && action === "leave") {
        await this.remove(member.id);
        return json({ ok: true });
      }
      if (request.method === "POST" && action === "end") {
        if (!member.host) return failure("\u4EC5\u4E3B\u6301\u4EBA\u53EF\u7ED3\u675F\u4F1A\u8BAE", 403);
        await this.end();
        return json({ ok: true });
      }
      return failure("\u4E0D\u652F\u6301\u7684\u8BF7\u6C42", 405);
    } catch (error) {
      return failure(error.message || "\u8BF7\u6C42\u5931\u8D25");
    }
  }
  addMember(name, host) {
    const member = { id: randomId(), token: randomId() + randomId(), name, host, muted: false, canShare: Boolean(host), expires: host ? this.room?.expires || Date.now() + 864e5 : Date.now() + 18e5 };
    this.members[member.id] = member;
    return member;
  }
  async ice() {
    if (!this.env.TURN_KEY_ID || !this.env.TURN_API_TOKEN) return failure("Worker \u5C1A\u672A\u914D\u7F6E Cloudflare TURN", 503);
    if (this.iceCache && this.iceCache.expiresAt > Date.now() + 3e5) return json(this.iceCache);
    if (!this.icePending) this.icePending = (async () => {
      const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(this.env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.env.TURN_API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ ttl: 86400 }),
        signal: AbortSignal.timeout(12e3)
      });
      if (!response.ok) throw new Error("Cloudflare TURN \u51ED\u636E\u6682\u65F6\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
      const payload = await response.json();
      this.iceCache = { iceServers: allowedIceServers(payload.iceServers), expiresAt: Date.now() + 864e5 };
      return this.iceCache;
    })().finally(() => {
      this.icePending = null;
    });
    try {
      return json(await this.icePending);
    } catch (error) {
      return failure(error.message, 503);
    }
  }
  async webSocketMessage(socket, data) {
    const attachment = socket.deserializeAttachment();
    if (!attachment || this.socket(attachment.id) !== socket) return;
    const member = this.members[attachment.id];
    if (!member || this.room?.ended || this.room?.expires <= Date.now()) {
      socket.close(4001, "expired");
      return;
    }
    if (typeof data !== "string" || data.length > 5e4) {
      socket.close(1009, "too large");
      return;
    }
    if (Date.now() - attachment.window > 1e4) {
      attachment.window = Date.now();
      attachment.count = 0;
    }
    attachment.count++;
    socket.serializeAttachment(attachment);
    if (attachment.count > 400) {
      socket.close(1008, "rate limited");
      return;
    }
    try {
      const msg = validateMessage(JSON.parse(data));
      if (!member.host && member.expires < Date.now() + 9e5) {
        member.expires = Date.now() + 18e5;
        await this.save();
      }
      if (msg.type === "ping") {
        this.send(socket, { type: "pong" });
        return;
      }
      if (msg.type === "renew") {
        if (!member.host) {
          member.expires = Date.now() + 18e5;
          await this.save();
        }
        this.send(socket, { type: "renewed", expires: member.expires });
        return;
      }
      if (msg.type === "signal") {
        const peer = this.socket(msg.to);
        if (peer && msg.to !== member.id) this.send(peer, { ...msg, from: member.id });
        return;
      }
      if (msg.type === "end") {
        if (!member.host) throw new Error("\u4EC5\u4E3B\u6301\u4EBA\u53EF\u7ED3\u675F\u4F1A\u8BAE");
        await this.end();
        return;
      }
      if (msg.type === "leave") {
        await this.remove(member.id);
        return;
      }
      if (msg.type === "grant-share") {
        if (!member.host) throw new Error("\u4EC5\u4E3B\u6301\u4EBA\u53EF\u5206\u914D\u5171\u4EAB\u6743\u9650");
        const target = this.members[msg.target];
        if (target) {
          target.canShare = Boolean(msg.canShare);
          if (this.room.sharer === msg.target && !msg.canShare) {
            this.room.sharer = null;
            this.room.sfu = null;
          }
        }
      }
      if (msg.type === "share-start") {
        if (!member.host && !member.canShare) throw new Error("\u9700\u4E3B\u6301\u4EBA\u6388\u6743\u540E\u65B9\u53EF\u5171\u4EAB\u5C4F\u5E55");
        if (this.room.sharer && this.room.sharer !== member.id) throw new Error("\u5DF2\u6709\u6210\u5458\u6B63\u5728\u5171\u4EAB");
        this.room.sharer = member.id;
        this.room.sfu = msg.sfu || null;
      }
      if (msg.type === "share-stop" && this.room.sharer === member.id) {
        this.room.sharer = null;
        this.room.sfu = null;
      }
      if (msg.type === "mute") member.muted = msg.muted;
      await this.save();
      this.broadcast(this.state());
    } catch (error) {
      this.send(socket, { type: "error", message: error.message });
    }
  }
  async remove(id) {
    const socket = this.socket(id);
    delete this.members[id];
    if (this.room.sharer === id) {
      this.room.sharer = null;
      this.room.sfu = null;
    }
    await this.save();
    if (socket) socket.close(1e3, "left");
    this.broadcast(this.state());
  }
  async webSocketClose(socket) {
    const id = socket.deserializeAttachment()?.id;
    if (this.socket(id)) return;
    if (this.members[id] && !this.members[id].host) this.members[id].expires = Date.now() + 18e5;
    if (this.room?.sharer === id) {
      this.room.sharer = null;
      this.room.sfu = null;
    }
    await this.save();
    this.broadcast(this.state());
  }
  async webSocketError(socket) {
    socket.close(1011, "connection failed");
    await this.webSocketClose(socket);
  }
  async end() {
    this.room.ended = true;
    this.room.sharer = null;
    this.room.sfu = null;
    this.members = {};
    await this.save();
    this.broadcast({ type: "ended" });
    for (const socket of this.sockets()) socket.close(1e3, "ended");
  }
  async alarm() {
    if (this.room) await this.end();
    await this.ctx.storage.deleteAll();
  }
};
export {
  MeetingRoom,
  index_default as default
};
//# sourceMappingURL=index.js.map
