require('dotenv').config();
const express = require('express');
const path = require('path');

const {
  NSP_BASE_URL,
  NSP_EMAIL,
  NSP_PASSWORD,
  PORT = 3000,
} = process.env;

if (!NSP_BASE_URL || !NSP_EMAIL || !NSP_PASSWORD) {
  console.warn('[nsp-proxy] NSP_BASE_URL / NSP_EMAIL / NSP_PASSWORD not fully set. Configure .env before making requests.');
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
  const res = await fetch(url, { method: 'POST' });
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
      Authentication: `Bearer ${token}`,
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

// Overview aggregates - keeps NSP query shapes server-side, returns only summary numbers.
app.get('/api/overview', async (_req, res) => {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 29);
    const sinceIso = since.toISOString().slice(0, 10) + 'T00:00:00Z';

    const [statusBuckets, recent, all] = await Promise.all([
      nspCall('api/publicapi/getentitylistbyquery', {
        entityType: 'SysTicket',
        page: 1,
        pageSize: 1000,
        columns: ['BaseEntityStatus', 'EntityType'],
      }),
      nspCall('api/publicapi/getentitylistbyquery', {
        entityType: 'SysTicket',
        page: 1,
        pageSize: 5000,
        columns: ['CreatedDate'],
        sorts: [{ field: 'CreatedDate', dir: 'asc' }],
        filters: { field: 'CreatedDate', operator: 'gte', value: sinceIso },
      }),
      nspCall('api/publicapi/getentitylistbyquery', {
        entityType: 'SysTicket',
        page: 1,
        pageSize: 1,
        columns: ['Id'],
      }),
    ]);

    const byStatus = {};
    const byType = {};
    for (const row of statusBuckets.Data || []) {
      const s = row.BaseEntityStatus || 'Unknown';
      byStatus[s] = (byStatus[s] || 0) + 1;
      const t = row.EntityType || 'Unknown';
      byType[t] = (byType[t] || 0) + 1;
    }

    const trend = {};
    for (let i = 0; i < 30; i++) {
      const d = new Date(since);
      d.setDate(since.getDate() + i);
      trend[d.toISOString().slice(0, 10)] = 0;
    }
    for (const row of recent.Data || []) {
      const day = (row.CreatedDate || '').slice(0, 10);
      if (day in trend) trend[day] += 1;
    }

    res.json({
      total: all.Total ?? (statusBuckets.Total ?? 0),
      sampleSize: (statusBuckets.Data || []).length,
      byStatus,
      byType,
      trend,
    });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, body: e.body ?? null });
  }
});

app.get('/api/health', async (_req, res) => {
  const configured = Boolean(NSP_BASE_URL && NSP_EMAIL && NSP_PASSWORD);
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
