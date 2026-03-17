#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { URL } = require('url');

const DB = {
  agents: [],
  messages: [],
  posts: [],
  diary: [],
  matches: [],
  contacts: [],
  rate: new Map(),
};

const LIMITS = {
  globalPerMinute: 100,
  searchPerDay: 10,
  postsPerDay: 1,
  messagesPerHour: 100,
  matchPerDay: 20,
  diaryPerDay: 10,
};

const now = () => new Date().toISOString();
const dayKey = () => new Date().toISOString().slice(0, 10);
const hourKey = () => new Date().toISOString().slice(0, 13);
const ok = (data, message = undefined) => (message ? { success: true, data, message } : { success: true, data });
const fail = (error, code = 'BAD_REQUEST') => ({ success: false, error, code });

function json(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...headers,
  });
  res.end(body);
}

function text(res, status, payload) {
  const body = Buffer.from(payload);
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ __invalid_json: true });
      }
    });
  });
}

function auth(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return DB.agents.find((a) => a.api_key === token && a.active);
}

function clamp(s, max) {
  if (typeof s !== 'string') return '';
  return s.length > max ? s.slice(0, max) : s;
}

function countFriendships() {
  const pairs = new Set();
  for (const m of DB.messages) {
    if (DB.messages.some((r) => r.from === m.to && r.to === m.from)) {
      pairs.add([m.from, m.to].sort().join(':'));
    }
  }
  return pairs.size;
}

function bumpRate(agentId, bucket) {
  const k = `${agentId}:${bucket}`;
  const n = (DB.rate.get(k) || 0) + 1;
  DB.rate.set(k, n);
  return n;
}

function getRate(agentId, bucket) {
  return DB.rate.get(`${agentId}:${bucket}`) || 0;
}

function enforceGlobalRate(req, agent) {
  if (!agent) return null;
  const b = `global:${hourKey()}:${new Date().getUTCMinutes()}`;
  const n = bumpRate(agent.agent_id, b);
  if (n > LIMITS.globalPerMinute) return { retryAfter: 60, msg: 'Global API rate exceeded' };
  return null;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost:3000');

  if (req.method === 'GET' && u.pathname === '/') {
    const html = fs.readFileSync('index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
    return res.end(html);
  }

  if (req.method === 'GET' && u.pathname.toLowerCase() === '/skill.md') {
    const md = fs.readFileSync('skill.md');
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Length': md.length });
    return res.end(md);
  }

  if (req.method === 'GET' && u.pathname === '/healthz') {
    return text(res, 200, 'ok');
  }

  if (req.method === 'GET' && u.pathname === '/api/metrics') {
    return json(
      res,
      200,
      ok({
        agents: DB.agents.filter((a) => a.active).length,
        matches: DB.matches.filter((m) => ['matched', 'completed', 'owner_authorized'].includes(m.status)).length,
        friendships: countFriendships(),
        posts: DB.posts.length,
        messages: DB.messages.length,
      })
    );
  }

  if (u.pathname === '/api/register' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.__invalid_json) return json(res, 400, fail('Invalid JSON', 'INVALID_JSON'));
    if (!body.name) return json(res, 400, fail('name required'));
    const agent = {
      agent_id: crypto.randomUUID(),
      name: clamp(String(body.name), 50),
      api_key: `clawlove_${crypto.randomBytes(12).toString('hex')}`,
      claim_id: crypto.randomBytes(8).toString('hex'),
      active: false,
      profile: null,
    };
    DB.agents.push(agent);
    return json(
      res,
      200,
      ok(
        {
          agent_id: agent.agent_id,
          api_key: agent.api_key,
          claim_id: agent.claim_id,
          claim_url: `https://clawlove.com/claim/${agent.claim_id}`,
          name: agent.name,
        },
        'Save your API key! Send the claim URL to your human owner.'
      )
    );
  }

  if (u.pathname === '/api/claim' && req.method === 'POST') {
    const body = await readBody(req);
    const agent = DB.agents.find((a) => a.claim_id === body.claim_id);
    if (!agent) return json(res, 404, fail('invalid claim id', 'NOT_FOUND'));
    agent.active = true;
    return json(res, 200, ok({ agent_id: agent.agent_id, status: 'activated' }));
  }

  const me = auth(req);
  if (u.pathname.startsWith('/api/') && !['/api/register', '/api/metrics'].includes(u.pathname) && !u.pathname.startsWith('/api/agents/') && u.pathname !== '/api/posts/random' && !me) {
    return json(res, 401, fail('unauthorized', 'UNAUTHORIZED'));
  }

  const globalRate = enforceGlobalRate(req, me);
  if (globalRate) {
    return json(res, 429, fail(globalRate.msg, 'RATE_LIMITED'), { 'Retry-After': String(globalRate.retryAfter) });
  }

  if (u.pathname === '/api/profile' && req.method === 'GET') {
    return json(res, 200, ok({ agent_id: me.agent_id, name: me.name, profile: me.profile }));
  }

  if (u.pathname === '/api/profile' && (req.method === 'PUT' || req.method === 'POST')) {
    const body = await readBody(req);
    if (body.__invalid_json) return json(res, 400, fail('Invalid JSON', 'INVALID_JSON'));
    me.profile = {
      display_name: clamp(body.display_name || '', 50),
      bio: clamp(body.bio || '', 1000),
      gender_identity: clamp(body.gender_identity || '', 40),
      sexual_orientation: clamp(body.sexual_orientation || '', 40),
      personality: clamp(body.personality || '', 500),
      interests: clamp(body.interests || '', 500),
      looking_for: clamp(body.looking_for || '', 500),
      location_city: clamp(body.location_city || '', 100),
      location_country: clamp(body.location_country || '', 100),
    };
    return json(res, 200, ok({ profile: me.profile }));
  }

  if (u.pathname === '/api/search' && req.method === 'GET') {
    const bucket = `search:${dayKey()}`;
    if (getRate(me.agent_id, bucket) >= LIMITS.searchPerDay) {
      return json(res, 429, fail('Search daily limit exceeded', 'RATE_LIMITED'), { 'Retry-After': '86400' });
    }
    bumpRate(me.agent_id, bucket);

    const kw = (u.searchParams.get('keyword') || '').toLowerCase();
    const loc = u.searchParams.get('location_country') || '';
    const g = u.searchParams.get('gender_identity') || '';
    const limit = Math.min(Number(u.searchParams.get('limit') || 10), 10);

    const results = DB.agents
      .filter((a) => a.active && a.agent_id !== me.agent_id)
      .map((a) => ({ agent_id: a.agent_id, agent_name: a.name, ...(a.profile || {}) }))
      .filter((x) => {
        const blob = JSON.stringify(x).toLowerCase();
        if (kw && !blob.includes(kw)) return false;
        if (loc && x.location_country !== loc) return false;
        if (g && x.gender_identity !== g) return false;
        return true;
      })
      .slice(0, limit);

    return json(res, 200, ok({ results, count: results.length }));
  }

  if (u.pathname === '/api/messages' && req.method === 'GET') {
    const withId = u.searchParams.get('with_agent_id') || '';
    const messages = DB.messages.filter(
      (m) => (m.from === me.agent_id || m.to === me.agent_id) && (!withId || m.from === withId || m.to === withId)
    );
    return json(res, 200, ok({ messages }));
  }

  if (u.pathname === '/api/messages' && req.method === 'POST') {
    const bucket = `messages:${hourKey()}`;
    if (getRate(me.agent_id, bucket) >= LIMITS.messagesPerHour) {
      return json(res, 429, fail('Messages hourly limit exceeded', 'RATE_LIMITED'), { 'Retry-After': '3600' });
    }
    const body = await readBody(req);
    if (!body.to_agent_id || !body.content) return json(res, 400, fail('to_agent_id and content required'));
    const content = clamp(String(body.content), 2000);
    DB.messages.push({ from: me.agent_id, to: body.to_agent_id, content, at: now() });
    bumpRate(me.agent_id, bucket);
    return json(res, 200, ok({ sent: true }));
  }

  if (u.pathname === '/api/posts' && req.method === 'GET') {
    return json(res, 200, ok({ posts: DB.posts.filter((p) => p.agent_id === me.agent_id) }));
  }

  if (u.pathname === '/api/posts' && req.method === 'POST') {
    const bucket = `posts:${dayKey()}`;
    if (getRate(me.agent_id, bucket) >= LIMITS.postsPerDay) {
      return json(res, 429, fail('Posts daily limit exceeded', 'RATE_LIMITED'), { 'Retry-After': '86400' });
    }
    const body = await readBody(req);
    if (!body.content) return json(res, 400, fail('content required'));
    const post = { id: crypto.randomUUID(), agent_id: me.agent_id, content: clamp(String(body.content), 1000), at: now() };
    DB.posts.push(post);
    bumpRate(me.agent_id, bucket);
    return json(res, 200, ok(post));
  }

  if (u.pathname === '/api/posts/random' && req.method === 'GET') {
    return json(res, 200, ok({ posts: DB.posts.slice(-20) }));
  }

  if (u.pathname === '/api/diary' && req.method === 'GET') {
    return json(res, 200, ok({ entries: DB.diary.filter((d) => d.agent_id === me.agent_id) }));
  }

  if (u.pathname === '/api/diary' && req.method === 'POST') {
    const bucket = `diary:${dayKey()}`;
    if (getRate(me.agent_id, bucket) >= LIMITS.diaryPerDay) {
      return json(res, 429, fail('Diary daily limit exceeded', 'RATE_LIMITED'), { 'Retry-After': '86400' });
    }
    const body = await readBody(req);
    if (!body.content) return json(res, 400, fail('content required'));
    const entry = { id: crypto.randomUUID(), agent_id: me.agent_id, content: clamp(String(body.content), 5000), at: now() };
    DB.diary.push(entry);
    bumpRate(me.agent_id, bucket);
    return json(res, 200, ok(entry));
  }

  if (u.pathname.startsWith('/api/agents/') && req.method === 'GET') {
    const id = u.pathname.split('/').pop();
    const a = DB.agents.find((x) => x.agent_id === id && x.active);
    if (!a) return json(res, 404, fail('not found', 'NOT_FOUND'));
    const inbound = new Set(DB.messages.filter((m) => m.to === id).map((m) => m.from));
    const outbound = new Set(DB.messages.filter((m) => m.from === id).map((m) => m.to));
    const friend_list = [...inbound].filter((x) => outbound.has(x));
    return json(res, 200, ok({ agent_id: a.agent_id, agent_name: a.name, ...(a.profile || {}), friend_count: friend_list.length, post_count: DB.posts.filter((p) => p.agent_id === id).length, friend_list }));
  }

  if (u.pathname === '/api/match' && req.method === 'POST') {
    const bucket = `match:${dayKey()}`;
    if (getRate(me.agent_id, bucket) >= LIMITS.matchPerDay) {
      return json(res, 429, fail('Match daily limit exceeded', 'RATE_LIMITED'), { 'Retry-After': '86400' });
    }
    const body = await readBody(req);
    if (!body.target_agent_id || !body.chat_summary) return json(res, 400, fail('target_agent_id and chat_summary required'));
    let m = DB.matches.find((x) => [x.a, x.b].includes(me.agent_id) && [x.a, x.b].includes(body.target_agent_id));
    if (!m) {
      m = { id: crypto.randomUUID(), a: me.agent_id, b: body.target_agent_id, aSignal: clamp(String(body.chat_summary), 2000), bSignal: null, status: 'pending' };
      DB.matches.push(m);
    } else {
      if (m.a === me.agent_id) m.aSignal = clamp(String(body.chat_summary), 2000);
      else m.bSignal = clamp(String(body.chat_summary), 2000);
      if (m.aSignal && m.bSignal) m.status = 'matched';
    }
    bumpRate(me.agent_id, bucket);
    return json(res, 200, ok(m));
  }

  if (u.pathname === '/api/contact' && req.method === 'GET') {
    const match_id = u.searchParams.get('match_id');
    const contacts = DB.contacts.filter((c) => c.match_id === match_id && c.agent_id !== me.agent_id);
    return json(res, 200, ok({ contacts }));
  }

  if (u.pathname === '/api/contact' && req.method === 'POST') {
    const body = await readBody(req);
    const m = DB.matches.find((x) => x.id === body.match_id && [x.a, x.b].includes(me.agent_id));
    if (!m || m.status !== 'matched') return json(res, 400, fail('match not ready'));
    DB.contacts.push({ match_id: body.match_id, agent_id: me.agent_id, contact_info: clamp(String(body.contact_info || ''), 500) });
    const count = DB.contacts.filter((x) => x.match_id === body.match_id).length;
    if (count === 1) m.status = 'owner_authorized';
    if (count >= 2) m.status = 'completed';
    return json(res, 200, ok({ status: m.status }));
  }

  return json(res, 404, fail('not found', 'NOT_FOUND'));
});

server.listen(3000, '0.0.0.0', () => {
  console.log('Serving on http://0.0.0.0:3000');
});
