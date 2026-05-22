require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const {
  NSP_BASE_URL,
  NSP_EMAIL,
  NSP_PASSWORD,
  NSP_API_TOKEN,
  PORT = 3000,
} = process.env;

if (!NSP_BASE_URL || (!NSP_API_TOKEN && (!NSP_EMAIL || !NSP_PASSWORD))) {
  console.warn('[nsp-proxy] Set NSP_BASE_URL plus either NSP_API_TOKEN, or NSP_EMAIL + NSP_PASSWORD, in .env.');
}

function nspUrl(pathname) {
  const base = NSP_BASE_URL.endsWith('/') ? NSP_BASE_URL : NSP_BASE_URL + '/';
  return new URL(pathname.replace(/^\//, ''), base);
}

// A "credentials context" bundles one set of NSP creds with its token cache
// and per-context status-id cache. The .env defaults live in `defaultCtx`;
// each logged-in browser session gets its own context.
function makeContext({ email, password, staticToken, label }) {
  return {
    label: label || email || 'token',
    email,
    password,
    staticToken: staticToken || null,
    cachedToken: null,
    inflightLogin: null,
    statusCache: null,
  };
}

const defaultCtx = makeContext({
  email: NSP_EMAIL,
  password: NSP_PASSWORD,
  staticToken: NSP_API_TOKEN,
  label: 'env-default',
});

async function login(ctx) {
  if (!NSP_BASE_URL || !ctx.email || !ctx.password) {
    throw new Error('NSP credentials not configured');
  }
  const url = nspUrl('api/logon/getauthenticationtoken');
  url.searchParams.set('email', ctx.email);
  url.searchParams.set('password', ctx.password);
  const res = await fetch(url, { method: 'GET' });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok || !data?.Success || !data?.Result?.Token) {
    const err = new Error(`NSP login failed: ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  ctx.cachedToken = {
    token: data.Result.Token,
    expiresAt: data.Result.Expires ? new Date(data.Result.Expires) : new Date(Date.now() + 10 * 60 * 1000),
  };
  return ctx.cachedToken;
}

async function getToken(ctx) {
  if (ctx.staticToken) return ctx.staticToken;
  if (ctx.cachedToken && ctx.cachedToken.expiresAt.getTime() - Date.now() > 60_000) {
    return ctx.cachedToken.token;
  }
  if (!ctx.inflightLogin) {
    ctx.inflightLogin = login(ctx).finally(() => { ctx.inflightLogin = null; });
  }
  const t = await ctx.inflightLogin;
  return t.token;
}

async function nspCall(ctx, pathname, body, { retry = true } = {}) {
  const token = await getToken(ctx);
  const res = await fetch(nspUrl(pathname), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (res.status === 401 && retry) {
    ctx.cachedToken = null;
    return nspCall(ctx, pathname, body, { retry: false });
  }
  if (!res.ok) {
    const err = new Error(`NSP ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// --- session store (in-memory) -----------------------------------------------
// sessionId -> { ctx, createdAt, lastSeen }
const sessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h idle

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join('='));
  }
  return out;
}

function reapSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastSeen > SESSION_TTL_MS) sessions.delete(id);
  }
}

function sessionMiddleware(req, res, next) {
  reapSessions();
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies.nsp_session;
  if (sid && sessions.has(sid)) {
    const s = sessions.get(sid);
    s.lastSeen = Date.now();
    req.sessionId = sid;
    req.ctx = s.ctx;
  } else {
    req.ctx = defaultCtx;
  }
  next();
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }
  const ctx = makeContext({ email, password, label: email });
  try {
    await login(ctx);
  } catch (e) {
    return res.status(401).json({ error: e.message, body: e.body ?? null });
  }
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, { ctx, createdAt: Date.now(), lastSeen: Date.now() });
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie',
    `nsp_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`);
  res.json({ ok: true, email });
});

app.post('/api/logout', (req, res) => {
  if (req.sessionId) sessions.delete(req.sessionId);
  res.setHeader('Set-Cookie', 'nsp_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (req.ctx === defaultCtx) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, email: req.ctx.email });
});

// Generic passthrough: POST /api/nsp/<anything> -> <NSP_BASE_URL>/api/<anything>
app.post('/api/nsp/*', async (req, res) => {
  const sub = req.params[0];
  try {
    const data = await nspCall(req.ctx, `api/${sub}`, req.body);
    res.json(data);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, body: e.body ?? null });
  }
});

const CLOSED_STATUS_NAMES = ['Closed', 'Resolved', 'Cancelled', 'Canceled', 'Released', 'Rejected', 'Completed', 'Done'];

async function getClosedStatusIds(ctx) {
  if (ctx.statusCache && ctx.statusCache.expiresAt > Date.now()) return ctx.statusCache;
  const data = await nspCall(ctx, 'api/publicapi/getentitylistbyquery', {
    entityType: 'SysTicket',
    page: 1,
    pageSize: 5000,
    columns: ['BaseEntityStatus'],
  });
  const nameById = new Map();
  for (const row of data.Data || []) {
    const id = row['BaseEntityStatus.Id'];
    const name = row['BaseEntityStatus'];
    if (id != null && name) nameById.set(id, name);
  }
  const lower = new Set(CLOSED_STATUS_NAMES.map(n => n.toLowerCase()));
  // id 29 is "Ready to close" on this install — still an open ticket, exclude.
  const FORCE_OPEN_IDS = new Set([29]);
  const ids = [...nameById.entries()]
    .filter(([id, name]) => lower.has(String(name).toLowerCase()) && !FORCE_OPEN_IDS.has(id))
    .map(([id]) => id);
  ctx.statusCache = {
    ids,
    nameById: Object.fromEntries(nameById),
    expiresAt: Date.now() + 10 * 60_000,
  };
  return ctx.statusCache;
}

async function countWhere(ctx, filters) {
  const data = await nspCall(ctx, 'api/publicapi/getentitylistbyquery', {
    entityType: 'SysTicket',
    page: 1,
    pageSize: 1,
    columns: ['Id'],
    ...(filters ? { filters } : {}),
  });
  return data.Total ?? 0;
}

app.get('/api/overview', async (req, res) => {
  const ctx = req.ctx;
  try {
    const since = new Date();
    since.setDate(since.getDate() - 29);
    const sinceIso = since.toISOString().slice(0, 10) + 'T00:00:00Z';

    const { ids: closedIds } = await getClosedStatusIds(ctx);
    const closedFilter = closedIds.length ? {
      logic: 'or',
      filters: closedIds.map(id => ({ field: 'BaseEntityStatus', operator: 'eq', value: id })),
    } : null;
    const openFilter = closedIds.length ? {
      logic: 'and',
      filters: closedIds.map(id => ({ field: 'BaseEntityStatus', operator: 'neq', value: id })),
    } : null;

    const closedSampleFilter = closedIds.length ? {
      logic: 'or',
      filters: closedIds.map(id => ({ field: 'BaseEntityStatus', operator: 'eq', value: id })),
    } : null;

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 6);
    weekAgo.setHours(0, 0, 0, 0);
    const weekAgoIso = weekAgo.toISOString();
    const closedLastWeekFilter = closedSampleFilter
      ? { logic: 'and', filters: [closedSampleFilter, { field: 'CloseDateTime', operator: 'gte', value: weekAgoIso }] }
      : null;

    const [total, closed, open, last30, statusSample, trendSample, closedSample, closedWeekSample, readyToCloseSample] = await Promise.all([
      countWhere(ctx, null),
      closedFilter ? countWhere(ctx, closedFilter) : Promise.resolve(0),
      openFilter ? countWhere(ctx, openFilter) : Promise.resolve(0),
      countWhere(ctx, { field: 'CreatedDate', operator: 'gte', value: sinceIso }),
      nspCall(ctx, 'api/publicapi/getentitylistbyquery', {
        entityType: 'SysTicket',
        page: 1,
        pageSize: 5000,
        columns: ['BaseEntityStatus', 'AgentGroup'],
        sorts: [{ field: 'CreatedDate', dir: 'desc' }],
      }),
      nspCall(ctx, 'api/publicapi/getentitylistbyquery', {
        entityType: 'SysTicket',
        page: 1,
        pageSize: 10000,
        columns: ['CreatedDate'],
        sorts: [{ field: 'CreatedDate', dir: 'asc' }],
        filters: { field: 'CreatedDate', operator: 'gte', value: sinceIso },
      }),
      closedSampleFilter ? nspCall(ctx, 'api/publicapi/getentitylistbyquery', {
        entityType: 'SysTicket',
        page: 1,
        pageSize: 5000,
        columns: ['CreatedDate', 'CloseDateTime', 'AgentGroup'],
        sorts: [{ field: 'CloseDateTime', dir: 'desc' }],
        filters: closedSampleFilter,
      }) : Promise.resolve({ Data: [] }),
      closedLastWeekFilter ? nspCall(ctx, 'api/publicapi/getentitylistbyquery', {
        entityType: 'SysTicket',
        page: 1,
        pageSize: 10000,
        columns: ['CloseDateTime', 'AgentGroup'],
        sorts: [{ field: 'CloseDateTime', dir: 'desc' }],
        filters: closedLastWeekFilter,
      }) : Promise.resolve({ Data: [] }),
      // Tickets in "Ready to close" (id 29) - shown as a recommended-action list.
      nspCall(ctx, 'api/publicapi/getentitylistbyquery', {
        entityType: 'SysTicket',
        page: 1,
        pageSize: 1000,
        columns: ['ReferenceNo', 'AgentGroup', 'CreatedDate'],
        sorts: [{ field: 'CreatedDate', dir: 'desc' }],
        filters: { field: 'BaseEntityStatus', operator: 'eq', value: 29 },
      }),
    ]);

    const STATUS_ID_OVERRIDES = {
      25: 'Waiting',
      26: 'Reopened',
      27: 'Awaiting decision',
      29: 'Ready to close',
    };
    const CLOSED_STATUS_IDS = new Set();

    const idToName = { ...STATUS_ID_OVERRIDES };
    for (const row of statusSample.Data || []) {
      const id = row['BaseEntityStatus.Id'];
      if (id != null && row.BaseEntityStatus && !idToName[id]) {
        idToName[id] = row.BaseEntityStatus;
      }
    }

    const labelFor = row => {
      const id = row['BaseEntityStatus.Id'];
      if (STATUS_ID_OVERRIDES[id]) return STATUS_ID_OVERRIDES[id];
      if (row.BaseEntityStatus) return row.BaseEntityStatus;
      if (idToName[id]) return idToName[id];
      if (id != null) return `Status #${id}`;
      return 'Unknown';
    };

    const HIDDEN_STATUS_NAMES = new Set(['closed', 'resolved']);

    const byStatus = {};
    const byAgentGroup = {};
    for (const row of statusSample.Data || []) {
      const s = labelFor(row);
      const id = row['BaseEntityStatus.Id'];
      if (HIDDEN_STATUS_NAMES.has(s.toLowerCase()) || CLOSED_STATUS_IDS.has(id)) continue;
      byStatus[s] = (byStatus[s] || 0) + 1;
      const g = row.AgentGroup || 'Unassigned';
      const bucket = byAgentGroup[g] || (byAgentGroup[g] = {});
      bucket[s] = (bucket[s] || 0) + 1;
    }

    const trend = {};
    for (let i = 0; i < 30; i++) {
      const d = new Date(since);
      d.setDate(since.getDate() + i);
      trend[d.toISOString().slice(0, 10)] = 0;
    }
    for (const row of trendSample.Data || []) {
      const day = (row.CreatedDate || '').slice(0, 10);
      if (day in trend) trend[day] += 1;
    }

    const closeAggregate = {};
    for (const row of closedSample.Data || []) {
      if (!row.CreatedDate || !row.CloseDateTime) continue;
      const ms = new Date(row.CloseDateTime) - new Date(row.CreatedDate);
      if (!Number.isFinite(ms) || ms <= 0) continue;
      const g = row.AgentGroup || 'Unassigned';
      const bucket = closeAggregate[g] || (closeAggregate[g] = { totalMs: 0, count: 0 });
      bucket.totalMs += ms;
      bucket.count += 1;
    }
    const avgCloseHoursByGroup = Object.fromEntries(
      Object.entries(closeAggregate).map(([g, v]) => [g, v.totalMs / v.count / 3_600_000])
    );

    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekAgo);
      d.setDate(weekAgo.getDate() + i);
      days.push(d.toISOString().slice(0, 10));
    }
    const closedByDayGroup = {};
    const groupTotals = {};
    for (const day of days) closedByDayGroup[day] = {};
    for (const row of closedWeekSample.Data || []) {
      if (!row.CloseDateTime) continue;
      const day = row.CloseDateTime.slice(0, 10);
      if (!(day in closedByDayGroup)) continue;
      const g = row.AgentGroup || 'Unassigned';
      closedByDayGroup[day][g] = (closedByDayGroup[day][g] || 0) + 1;
      groupTotals[g] = (groupTotals[g] || 0) + 1;
    }
    const closedLastWeek = {
      days: days.slice().reverse(),
      groups: Object.entries(groupTotals).sort((a, b) => b[1] - a[1]).map(([g]) => g),
      counts: closedByDayGroup,
    };

    const readyToClose = (readyToCloseSample.Data || []).map(row => ({
      ref: row.ReferenceNo,
      group: row.AgentGroup || 'Unassigned',
      created: row.CreatedDate,
    }));

    res.json({
      total,
      open,
      closed,
      last30Days: last30,
      byStatus,
      byAgentGroup,
      avgCloseHoursByGroup,
      closedLastWeek,
      readyToClose,
      trend,
    });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, body: e.body ?? null });
  }
});

function localOnly(req, res, next) {
  const ip = req.socket.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  res.status(403).json({ error: 'debug endpoints are localhost-only' });
}

app.get('/api/debug/by-status/:id', localOnly, async (req, res) => {
  const id = Number(req.params.id);
  const limit = Math.min(Number(req.query.limit) || 5, 100);
  try {
    const data = await nspCall(req.ctx, 'api/publicapi/getentitylistbyquery', {
      entityType: 'SysTicket',
      page: 1,
      pageSize: limit,
      filters: { field: 'BaseEntityStatus', operator: 'eq', value: id },
      sorts: [{ field: 'CreatedDate', dir: 'desc' }],
    });
    res.json({ id, total: data.Total, sample: data.Data });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, body: e.body ?? null });
  }
});

app.get('/api/debug/unknown', localOnly, async (req, res) => {
  try {
    const data = await nspCall(req.ctx, 'api/publicapi/getentitylistbyquery', {
      entityType: 'SysTicket',
      page: 1,
      pageSize: 5000,
      columns: ['ReferenceNo', 'BaseEntityStatus', 'AgentGroup', 'CreatedDate'],
      sorts: [{ field: 'CreatedDate', dir: 'desc' }],
    });
    const unknowns = (data.Data || []).filter(r => !r.BaseEntityStatus);
    res.json({ count: unknowns.length, sample: unknowns.slice(0, 10) });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, body: e.body ?? null });
  }
});

app.get('/api/debug/statuses', localOnly, async (req, res) => {
  try {
    req.ctx.statusCache = null;
    const cache = await getClosedStatusIds(req.ctx);
    res.json({ closedIds: cache.ids, nameById: cache.nameById });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, body: e.body ?? null });
  }
});

app.get('/api/health', async (req, res) => {
  const ctx = req.ctx;
  const configured = Boolean(NSP_BASE_URL && (ctx.staticToken || (ctx.email && ctx.password)));
  let tokenOk = false;
  let error = null;
  if (configured) {
    try { await getToken(ctx); tokenOk = true; } catch (e) { error = e.message; }
  }
  res.json({
    ok: true,
    nspConfigured: configured,
    tokenOk,
    error,
    user: ctx === defaultCtx ? null : ctx.email,
  });
});

app.listen(PORT, () => {
  console.log(`[nsp-dashboard] listening on http://localhost:${PORT}`);
});
