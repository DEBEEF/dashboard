# NSP Overview Dashboard

A Tabler-based overview dashboard that talks to your NSP instance through a small
Node.js proxy. The API token only lives on the server (in `.env`); the browser
never sees it.

## Run

```bash
npm install
cp .env.example .env   # set NSP_BASE_URL and NSP_API_TOKEN
npm start
```

Open http://localhost:3000.

## How it works

- `server.js` - Express app. Serves `public/` and exposes:
  - `GET /api/overview` - aggregates totals / status breakdown / 30-day trend
    by calling `api/publicapi/getentitylistbyquery` on `SysTicket`. All NSP
    queries are constructed server-side; the client cannot influence
    entityType, columns, filters, or page size.
  - `GET /api/health` - reports whether the proxy is configured.
  - `POST /api/login`, `POST /api/logout`, `GET /api/me` - optional per-user
    NSP login. Anonymous visitors use the `.env` credentials.
  - `GET /api/debug/*` - localhost-only inspection helpers.
- `public/` - Tabler (CDN) + ApexCharts. No build step.

## Auth

On the first request the proxy calls
`POST /api/logon/getauthenticationtoken?email=…&password=…`, caches the returned
token until ~1 minute before `Expires`, and sends it on every subsequent NSP
call as `Authentication: Bearer <token>`. A 401 response invalidates the cache
and the request is retried once.
