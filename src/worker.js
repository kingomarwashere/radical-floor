// The Floor — Worker: the live debate floor for theradicalparty.com.
// Serves the SPA (via ASSETS), upgrades WebSockets into per-room Durable Objects,
// validates identity against the shared radical-db, lets people propose from chat,
// and exposes the live-activity feed that powers the main-site widget.

import { Room } from './room.js';
import { Directory } from './directory.js';
export { Room, Directory };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

const ROOM_RE = /^[a-zA-Z0-9_]{1,80}$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      // ---- WebSocket: join a room ----------------------------------------
      if (pathname === '/ws') return handleWS(request, env, url);

      // ---- identity: who am I --------------------------------------------
      if (pathname === '/api/me') {
        const uid = url.searchParams.get('uid') || '';
        const user = await lookupUser(env, uid);
        if (!user) return json({ error: 'unknown user' }, 404);
        return json({ user });
      }

      // ---- create a proposal straight from chat --------------------------
      if (pathname === '/api/propose' && request.method === 'POST') {
        return handlePropose(request, env, ctx);
      }

      // ---- ensure/lookup a proposal's debate room ------------------------
      if (pathname === '/api/proposal-room') {
        const ref = url.searchParams.get('ref') || '';
        const room = await proposalRoom(env, ref);
        if (!room) return json({ error: 'unknown proposal' }, 404);
        return json({ room });
      }

      // ---- live activity feed (main-site widget + SPA sidebar) -----------
      if (pathname === '/api/activity') {
        const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName('global'));
        const res = await stub.fetch('https://internal/activity');
        const body = await res.text();
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } });
      }

      if (pathname === '/api/health') return json({ ok: true, service: 'radical-floor' });

      // Everything else → static assets / SPA fallback.
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: 'server error', detail: String(err && err.message || err) }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
async function handleWS(request, env, url) {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('expected websocket', { status: 426 });
  }
  const roomId = url.searchParams.get('room') || 'square';
  if (!ROOM_RE.test(roomId)) return new Response('bad room', { status: 400 });

  const uid = url.searchParams.get('uid') || '';
  const user = await lookupUser(env, uid);
  if (!user) return new Response('sign in on theradicalparty.com first', { status: 401 });

  // Resolve room kind/topic. Proposal rooms are 'p_<proposalId>'.
  let kind = 'square', topic = '', ref = '';
  if (roomId !== 'square') {
    const rr = await roomMetaFromId(env, roomId);
    if (!rr) return new Response('unknown room', { status: 404 });
    kind = rr.kind; topic = rr.topic; ref = rr.ref;
  }

  // Forward into the room's Durable Object.
  const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  const inner = new URL('https://internal/connect');
  inner.searchParams.set('room', roomId);
  inner.searchParams.set('kind', kind);
  inner.searchParams.set('topic', topic);
  inner.searchParams.set('ref', ref);
  inner.searchParams.set('uid', user.id);
  inner.searchParams.set('name', user.name);
  inner.searchParams.set('avatar', user.avatar_url || '');

  return stub.fetch(new Request(inner, request));
}

// ---------------------------------------------------------------------------
async function handlePropose(request, env, ctx) {
  let data;
  try { data = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const uid = String(data.uid || '');
  const text = String(data.text || '').trim().slice(0, 280);
  if (!text) return json({ error: 'empty proposal' }, 400);

  const user = await lookupUser(env, uid);
  if (!user) return json({ error: 'sign in first' }, 401);

  // Mirror the main site's proposal shape exactly.
  const id = 'proposal_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  const ts = Date.now();
  try {
    await env.RADICAL_DB.prepare(
      `INSERT INTO proposals (id, author_id, text, timestamp, trending) VALUES (?, ?, ?, ?, ?)`
    ).bind(id, user.id, text, ts, 0).run();
  } catch (e) {
    return json({ error: 'could not create proposal', detail: String(e.message || e) }, 500);
  }

  // Register the debate room in The Floor's own registry.
  const roomId = 'p_' + id;
  const topic = text.slice(0, 120);
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO rooms (id, kind, topic, ref_id, created_at, last_active, msg_count)
       VALUES (?, 'proposal', ?, ?, ?, ?, 0)`
    ).bind(roomId, topic, id, ts, ts).run();
  } catch (e) { /* registry is best-effort */ }

  return json({
    proposalId: id,
    room: { id: roomId, kind: 'proposal', topic, ref: id },
    url: (env.MAIN_SITE || 'https://theradicalparty.com') + '/?proposal=' + id,
  });
}

// ---------------------------------------------------------------------------
// Look up a user in the shared platform DB — this is the shared identity.
async function lookupUser(env, uid) {
  if (!uid) return null;
  try {
    return await env.RADICAL_DB.prepare(
      `SELECT id, name, avatar_url FROM users WHERE id = ?`
    ).bind(uid).first();
  } catch { return null; }
}

// Resolve a proposal room from its 'p_<proposalId>' id, creating registry lazily.
async function roomMetaFromId(env, roomId) {
  if (!roomId.startsWith('p_')) return null;
  const ref = roomId.slice(2);
  // Prefer the registry, fall back to the live proposal in radical-db.
  try {
    const reg = await env.DB.prepare(`SELECT topic, ref_id FROM rooms WHERE id = ?`).bind(roomId).first();
    if (reg) return { kind: 'proposal', topic: reg.topic || '', ref: reg.ref_id || ref };
  } catch {}
  try {
    const p = await env.RADICAL_DB.prepare(`SELECT id, text FROM proposals WHERE id = ?`).bind(ref).first();
    if (!p) return null;
    const topic = (p.text || '').slice(0, 120);
    env.DB.prepare(
      `INSERT OR IGNORE INTO rooms (id, kind, topic, ref_id, created_at, last_active, msg_count)
       VALUES (?, 'proposal', ?, ?, ?, ?, 0)`
    ).bind(roomId, topic, ref, Date.now(), Date.now()).run().catch(() => {});
    return { kind: 'proposal', topic, ref };
  } catch { return null; }
}

async function proposalRoom(env, ref) {
  if (!ref) return null;
  const roomId = 'p_' + ref;
  const meta = await roomMetaFromId(env, roomId);
  if (!meta) return null;
  return { id: roomId, ...meta };
}
