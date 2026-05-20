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
  - `POST /api/nsp/*` - generic passthrough, forwards body to `<NSP_BASE_URL>/api/*`
    and injects the auth header.
  - `GET /api/overview` - aggregates totals / status breakdown / 30-day trend
    by calling `api/publicapi/getentitylistbyquery` on `SysTicket`.
  - `GET /api/health` - reports whether the proxy is configured.
- `public/` - Tabler (CDN) + ApexCharts. No build step.

## Auth header

By default the proxy sends `Authorization: Bearer <token>`. Override with
`NSP_AUTH_HEADER` / `NSP_AUTH_SCHEME` in `.env` if your NSP build expects a
different header (some installations use a custom header instead of Bearer).
