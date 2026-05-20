require('dotenv').config();
const express = require('express');
const path = require('path');

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

let cachedToken = null; // { token, expiresAt: Date }
let inflightLogin = null;

async function login() {
  if (!NSP_BASE_URL || !NSP_EMAIL || !NSP_PASSWORD) {
    throw new Error('NSP credentials not configured');
  }
  const url = nspUrl('api/logon/getauthenticationtoken');
  url.searchParams.set('email', NSP_EMAIL);
  url.searchParams.set('password', NSP_PASSWORD);
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
  cachedToken = {
    token: data.Result.Token,
    expiresAt: data.Result.Expires ? new Date(data.Result.Expires) : new Date(Date.now() + 10 * 60 * 1000),
  };
  return cachedToken;
}

async function getToken() {
  if (NSP_API_TOKEN) return NSP_API_TOKEN;
  if (cachedToken && cachedToken.expiresAt.getTime() - Date.now() > 60_000) {
    return cachedToken.token;
  }
  if (!inflightLogin) {
    inflightLogin = login().finally(() => { inflightLogin = null; });
  }
  const t = await inflightLogin;
  return t.token;
}

async function nspCall(pathname, body, { retry = true } = {}) {
  const token = await getToken();
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
    cachedToken = null;
    return nspCall(pathname, body, { retry: false });
  }
  if (!res.ok) {
    const err = new Error(`NSP ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Generic passthrough: POST /api/nsp/<anything> -> <NSP_BASE_URL>/api/<anything>
app.post('/api/nsp/*', async (req, res) => {
  const sub = req.params[0];
  try {
    const data = await nspCall(`api/${sub}`, req.body);
    res.json(data);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, body: e.body ?? null });
  }
});

const CLOSED_STATUS_NAMES = ['Closed', 'Resolved', 'Cancelled', 'Canceled', 'Released', 'Rejected', 'Completed', 'Done'];

let statusCache = null; // { ids, nameById, expiresAt }
async function getClosedStatusIds() {
  if (statusCache && statusCache.expiresAt > Date.now()) return statusCache;
  // Sample tickets to learn the name<->id mapping; each row carries both
  // BaseEntityStatus (name) and BaseEntityStatus.Id (int).
  const data = await nspCall('api/publicapi/getentitylistbyquery', {
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
  const ids = [...nameById.entries()]
    .filter(([, name]) => lower.has(String(name).toLowerCase()))
    .map(([id]) => id);
  statusCache = {
    ids,
    nameById: Object.fromEntries(nameById),
    expiresAt: Date.now() + 10 * 60_000,
  };
  console.log('[nsp-proxy] discovered statuses:', Object.fromEntries(nameById));
  console.log('[nsp-proxy] closed status ids:', ids);
  return statusCache;
}

async function countWhere(filters) {
  const data = await nspCall('api/publicapi/getentitylistbyquery', {
    entityType: 'SysTicket',
    page: 1,
    pageSize: 1,
    columns: ['Id'],
    ...(filters ? { filters } : {}),
  });
  return data.Total ?? 0;
}

app.get('/api/overview', async (_req, res) => {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 29);
    const sinceIso = since.toISOString().slice(0, 10) + 'T00:00:00Z';

    const { ids: closedIds } = await getClosedStatusIds();
    const closedFilter = closedIds.length ? {
      logic: 'or',
      filters: closedIds.map(id => ({ field: 'BaseEntityStatus', operator: 'eq', value: id })),
    } : null;
    const openFilter = closedIds.length ? {
      logic: 'and',
      filters: closedIds.map(id => ({ field: 'BaseEntityStatus', operator: 'neq', value: id })),
    } : null;

    const [total, closed, open, last30, statusSample, trendSample] = await Promise.all([
      countWhere(null),
      closedFilter ? countWhere(closedFilter) : Promise.resolve(0),
      openFilter ? countWhere(openFilter) : Promise.resolve(0),
      countWhere({ field: 'CreatedDate', operator: 'gte', value: sinceIso }),
      // Larger sample purely for the status + agent-group breakdown
      nspCall('api/publicapi/getentitylistbyquery', {
        entityType: 'SysTicket',
        page: 1,
        pageSize: 5000,
        columns: ['BaseEntityStatus', 'AgentGroup'],
        sorts: [{ field: 'CreatedDate', dir: 'desc' }],
      }),
      // Trend: last 30 days of CreatedDate
      nspCall('api/publicapi/getentitylistbyquery', {
        entityType: 'SysTicket',
        page: 1,
        pageSize: 10000,
        columns: ['CreatedDate'],
        sorts: [{ field: 'CreatedDate', dir: 'asc' }],
        filters: { field: 'CreatedDate', operator: 'gte', value: sinceIso },
      }),
    ]);

    // Known status IDs whose names NSP doesn't return on this install
    const STATUS_ID_OVERRIDES = {
      25: 'Waiting',
      26: 'Reopened',
      27: 'Awaiting decision',
    };
    // Status IDs to treat as "Closed" even if NSP names them differently
    const CLOSED_STATUS_IDS = new Set([29]);

    // First pass: build id -> name map from rows where NSP did resolve the name
    const idToName = { ...STATUS_ID_OVERRIDES };
    for (const row of statusSample.Data || []) {
      const id = row['BaseEntityStatus.Id'];
      if (id != null && row.BaseEntityStatus && !idToName[id]) {
        idToName[id] = row.BaseEntityStatus;
      }
    }

    const labelFor = row => {
      const id = row['BaseEntityStatus.Id'];
      if (row.BaseEntityStatus) return row.BaseEntityStatus;
      if (idToName[id]) return idToName[id];
      if (id != null) return `Status #${id}`;
      return 'Unknown';
    };

    // Statuses to hide from charts entirely (treated as "done")
    const HIDDEN_STATUS_NAMES = new Set(['closed', 'resolved']);

    const byStatus = {};
    const byAgentGroup = {}; // { group: { statusName: count } } - excludes closed statuses
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

    res.json({
      total,
      open,
      closed,
      last30Days: last30,
      byStatus,
      byAgentGroup,
      trend,
    });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, body: e.body ?? null });
  }
});

// View raw tickets for a given BaseEntityStatus.Id:
//   GET /api/debug/by-status/26       -> first 5 tickets with that status id
//   GET /api/debug/by-status/26?limit=20
app.get('/api/debug/by-status/:id', async (req, res) => {
  const id = Number(req.params.id);
  const limit = Math.min(Number(req.query.limit) || 5, 100);
  try {
    const data = await nspCall('api/publicapi/getentitylistbyquery', {
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

app.get('/api/debug/unknown', async (_req, res) => {
  try {
    const data = await nspCall('api/publicapi/getentitylistbyquery', {
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

app.get('/api/debug/statuses', async (_req, res) => {
  try {
    statusCache = null;
    const cache = await getClosedStatusIds();
    res.json({ closedIds: cache.ids, nameById: cache.nameById });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, body: e.body ?? null });
  }
});

app.get('/api/health', async (_req, res) => {
  const configured = Boolean(NSP_BASE_URL && (NSP_API_TOKEN || (NSP_EMAIL && NSP_PASSWORD)));
  let tokenOk = false;
  let error = null;
  if (configured) {
    try { await getToken(); tokenOk = true; } catch (e) { error = e.message; }
  }
  res.json({ ok: true, nspConfigured: configured, tokenOk, error });
});

app.listen(PORT, () => {
  console.log(`[nsp-dashboard] listening on http://localhost:${PORT}`);
});
