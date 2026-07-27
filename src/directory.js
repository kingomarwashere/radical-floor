// Directory — one singleton DO (idFromName('global')) that every Room heartbeats
// into. It holds a live map of active rooms + headcounts so the Worker can answer
// "what's the town square doing right now" and "which proposals are being argued"
// — the data that powers the activity widget on the main site.

const STALE_MS = 75_000; // drop a room if it hasn't beaten in this long

export class Directory {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.rooms = null; // Map<roomId, {kind,topic,ref,count,ts}>
  }

  async load() {
    if (this.rooms) return;
    this.rooms = (await this.ctx.storage.get('rooms')) || new Map();
  }
  async save() {
    await this.ctx.storage.put('rooms', this.rooms);
  }

  prune() {
    const now = Date.now();
    for (const [id, r] of this.rooms) {
      if (now - r.ts > STALE_MS || r.count <= 0) this.rooms.delete(id);
    }
  }

  async fetch(request) {
    await this.load();
    const url = new URL(request.url);

    if (url.pathname.endsWith('/beat') && request.method === 'POST') {
      const b = await request.json();
      if (b.count > 0) {
        this.rooms.set(b.room, {
          kind: b.kind, topic: b.topic || '', ref: b.ref || '',
          count: b.count, ts: b.ts || Date.now(),
        });
      } else {
        this.rooms.delete(b.room);
      }
      this.prune();
      await this.save();
      return Response.json({ ok: true });
    }

    if (url.pathname.endsWith('/activity')) {
      this.prune();
      await this.save();

      let online = 0;
      const proposals = [];
      let squareCount = 0;
      for (const [id, r] of this.rooms) {
        online += r.count;
        if (r.kind === 'square') squareCount = r.count;
        else if (r.kind === 'proposal') {
          proposals.push({ room: id, ref: r.ref, topic: r.topic, count: r.count });
        }
      }
      proposals.sort((a, b) => b.count - a.count);
      return Response.json({
        online,
        square: squareCount,
        rooms: this.rooms.size,
        hot: proposals.slice(0, 8),
      });
    }

    return new Response('not found', { status: 404 });
  }
}
