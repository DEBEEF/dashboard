require('dotenv').config();
const express = require('express');
const path = require('path');

const {
  NSP_BASE_URL,
  NSP_API_TOKEN,
  NSP_AUTH_HEADER = 'Authorization',
  NSP_AUTH_SCHEME = 'Bearer',
  PORT = 3000,
} = process.env;

if (!NSP_BASE_URL || !NSP_API_TOKEN) {
  console.warn('[nsp-proxy] NSP_BASE_URL or NSP_API_TOKEN is not set. Set them in .env before making requests.');
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function nspHeaders() {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (NSP_API_TOKEN) {
    headers[NSP_AUTH_HEADER] = NSP_AUTH_SCHEME ? `${NSP_AUTH_SCHEME} ${NSP_API_TOKEN}` : NSP_API_TOKEN;
  }
  return headers;
}

async function nspCall(pathname, body) {
  if (!NSP_BASE_URL) throw new Error('NSP_BASE_URL not configured');
  const url = new URL(pathname.replace(/^\//, ''), NSP_BASE_URL.endsWith('/') ? NSP_BASE_URL : NSP_BASE_URL + '/');
  const res = await fetch(url, {
    method: 'POST',
    headers: nspHeaders(),
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`NSP ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

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
      // Total tickets, with status name resolved
      nspCall('api/publicapi/getentitylistbyquery', {
        entityType: 'SysTicket',
        page: 1,
        pageSize: 1000,
        columns: ['BaseEntityStatus', 'EntityType'],
      }),
      // Last 30 days for the trend chart
      nspCall('api/publicapi/getentitylistbyquery', {
        entityType: 'SysTicket',
        page: 1,
        pageSize: 5000,
        columns: ['CreatedDate'],
        sorts: [{ field: 'CreatedDate', dir: 'asc' }],
        filters: { field: 'CreatedDate', operator: 'gte', value: sinceIso },
      }),
      // Total (any status) - just need the Total count
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

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, nspConfigured: Boolean(NSP_BASE_URL && NSP_API_TOKEN) });
});

app.listen(PORT, () => {
  console.log(`[nsp-dashboard] listening on http://localhost:${PORT}`);
});
