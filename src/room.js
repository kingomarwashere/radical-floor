// Room — one Durable Object per channel (the town square, or a proposal debate).
// Uses the WebSocket hibernation API so idle rooms cost nothing: the DO can be
// evicted from memory while sockets stay open, and is re-woken on the next event.
//
// Responsibilities:
//   - fan out chat / typing / reaction events to everyone in the room
//   - keep the last N messages in DO SQLite for instant scroll-back on join
//   - track live presence (who's here) surviving hibernation via attachments
//   - for proposal rooms, surface the live vote tally from the main radical-db
//   - heartbeat active headcount + topic into the Directory singleton

const RECENT_LIMIT = 60;        // messages sent to a client on join
const KEEP_LIMIT = 400;         // messages retained per room in DO SQLite
const TALLY_TTL_MS = 8000;      // cache proposal tally for this long

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this._tally = null;
    this._tallyAt = 0;

    this.sql.exec(`CREATE TABLE IF NOT EXISTS msg (
      id TEXT PRIMARY KEY, uid TEXT, name TEXT, avatar TEXT, body TEXT, ts INTEGER
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_msg_ts ON msg(ts)`);
  }

  // ---- meta helpers -------------------------------------------------------
  async meta() {
    return (await this.ctx.storage.get('meta')) || null;
  }
  async setMeta(m) {
    await this.ctx.storage.put('meta', m);
  }

  // ---- HTTP entry (called by the Worker) ----------------------------------
  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket upgrade — the Worker has already validated the user.
    if (url.pathname.endsWith('/connect')) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }

      // Persist room identity on first connect (id, kind, topic, ref proposal).
      if (!(await this.meta())) {
        await this.setMeta({
          id: url.searchParams.get('room') || 'square',
          kind: url.searchParams.get('kind') || 'square',
          topic: url.searchParams.get('topic') || '',
          ref: url.searchParams.get('ref') || '',
          created: Date.now(),
        });
      }

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      const user = {
        uid: url.searchParams.get('uid') || 'anon',
        name: url.searchParams.get('name') || 'Radical',
        avatar: url.searchParams.get('avatar') || '',
      };
      // Attachment survives hibernation so we know who a socket belongs to.
      server.serializeAttachment(user);
      this.ctx.acceptWebSocket(server);

      // Prime the client: recent history + current presence + (maybe) tally.
      const recent = this.recentMessages();
      const tally = await this.tally();
      server.send(JSON.stringify({
        t: 'hello',
        room: await this.meta(),
        you: user,
        messages: recent,
        presence: this.presence(),
        tally,
      }));

      this.broadcast({ t: 'presence', presence: this.presence(), joined: user.name }, server);
      await this.heartbeat();

      return new Response(null, { status: 101, webSocket: client });
    }

    // Internal: nudge the room to re-check + rebroadcast the vote tally.
    if (url.pathname.endsWith('/tally')) {
      this._tallyAt = 0;
      const tally = await this.tally();
      this.broadcast({ t: 'tally', tally });
      return Response.json({ tally });
    }

    return new Response('not found', { status: 404 });
  }

  // ---- WebSocket hibernation handlers -------------------------------------
  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const user = ws.deserializeAttachment() || {};

    if (msg.t === 'chat') {
      const body = String(msg.body || '').slice(0, 1000).trim();
      if (!body) return;
      const rec = {
        id: crypto.randomUUID(),
        uid: user.uid,
        name: user.name,
        avatar: user.avatar || '',
        body,
        ts: Date.now(),
      };
      this.store(rec);
      this.broadcast({ t: 'chat', msg: rec });
      await this.heartbeat();
      return;
    }

    if (msg.t === 'typing') {
      this.broadcast({ t: 'typing', name: user.name, uid: user.uid }, ws);
      return;
    }

    if (msg.t === 'react') {
      // Lightweight ephemeral reaction ping — not archived.
      this.broadcast({ t: 'react', emoji: String(msg.emoji || '✊').slice(0, 8), name: user.name });
      return;
    }

    if (msg.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong' }));
      return;
    }
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch {}
    this.broadcast({ t: 'presence', presence: this.presence() });
    await this.heartbeat();
  }
  async webSocketError(ws) {
    this.broadcast({ t: 'presence', presence: this.presence() });
  }

  // ---- presence -----------------------------------------------------------
  sockets() {
    return this.ctx.getWebSockets();
  }
  presence() {
    const seen = new Map();
    for (const ws of this.sockets()) {
      const u = ws.deserializeAttachment();
      if (u && u.uid) seen.set(u.uid, { name: u.name, avatar: u.avatar || '' });
    }
    return { count: seen.size, users: [...seen.values()].slice(0, 50) };
  }

  broadcast(obj, except) {
    const data = JSON.stringify(obj);
    for (const ws of this.sockets()) {
      if (ws === except) continue;
      try { ws.send(data); } catch {}
    }
  }

  // ---- message persistence ------------------------------------------------
  store(rec) {
    this.sql.exec(
      `INSERT INTO msg (id, uid, name, avatar, body, ts) VALUES (?, ?, ?, ?, ?, ?)`,
      rec.id, rec.uid, rec.name, rec.avatar, rec.body, rec.ts
    );
    // Trim to KEEP_LIMIT newest.
    this.sql.exec(
      `DELETE FROM msg WHERE id IN (
         SELECT id FROM msg ORDER BY ts DESC LIMIT -1 OFFSET ?
       )`, KEEP_LIMIT
    );
  }
  recentMessages() {
    const rows = [...this.sql.exec(
      `SELECT id, uid, name, avatar, body, ts FROM msg ORDER BY ts DESC LIMIT ?`, RECENT_LIMIT
    )];
    return rows.reverse();
  }

  // ---- proposal vote tally (proposal rooms only) --------------------------
  async tally() {
    const meta = await this.meta();
    if (!meta || meta.kind !== 'proposal' || !meta.ref) return null;
    if (this._tally && Date.now() - this._tallyAt < TALLY_TTL_MS) return this._tally;
    try {
      const row = await this.env.RADICAL_DB.prepare(`
        SELECT
          (SELECT COUNT(*) FROM votes WHERE proposal_id = ? AND vote_type = 'upvote')   AS up,
          (SELECT COUNT(*) FROM votes WHERE proposal_id = ? AND vote_type = 'downvote') AS down,
          (SELECT COUNT(*) FROM votes WHERE proposal_id = ? AND vote_type = 'upvote' AND is_petition = 1) AS petition
      `).bind(meta.ref, meta.ref, meta.ref).first();
      this._tally = { proposalId: meta.ref, up: row?.up || 0, down: row?.down || 0, petition: row?.petition || 0 };
      this._tallyAt = Date.now();
    } catch {
      this._tally = { proposalId: meta.ref, up: 0, down: 0, petition: 0 };
    }
    return this._tally;
  }

  // ---- directory heartbeat ------------------------------------------------
  async heartbeat() {
    const meta = await this.meta();
    if (!meta) return;
    const p = this.presence();
    const id = this.env.DIRECTORY.idFromName('global');
    const stub = this.env.DIRECTORY.get(id);
    this.ctx.waitUntil(stub.fetch('https://internal/beat', {
      method: 'POST',
      body: JSON.stringify({
        room: meta.id,
        kind: meta.kind,
        topic: meta.topic,
        ref: meta.ref,
        count: p.count,
        ts: Date.now(),
      }),
    }).catch(() => {}));
  }
}
