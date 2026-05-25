const LOCALE = 'sv-SE';

const STATUS_SV = {
  Waiting: 'Väntar',
  Reopened: 'Återöppnad',
  'Awaiting decision': 'Väntar på beslut',
  'Ready to close': 'Redo att stängas',
  Closed: 'Stängd',
  Resolved: 'Löst',
  Cancelled: 'Avbruten',
  Canceled: 'Avbruten',
  Released: 'Frisläppt',
  Rejected: 'Avvisad',
  Completed: 'Slutförd',
  Done: 'Klar',
  Unknown: 'Okänd',
  Unassigned: 'Otilldelad',
};

const ERROR_SV = {
  'email and password required': 'e-post och lösenord krävs',
  'Login failed': 'Inloggning misslyckades',
  'NSP credentials not configured': 'NSP-uppgifter är inte konfigurerade',
};

function trStatus(name) {
  return STATUS_SV[name] || name;
}

function trError(msg) {
  if (!msg) return msg;
  return ERROR_SV[msg] || msg.replace(/^NSP login failed:/, 'NSP-inloggning misslyckades:')
    .replace(/^Failed to load NSP data:/, 'Kunde inte ladda NSP-data:');
}

async function loadHealth() {
  const badge = document.getElementById('health');
  try {
    const r = await fetch('/api/health').then(r => r.json());
    if (!r.nspConfigured) {
      badge.className = 'badge bg-yellow-lt align-self-center';
      badge.textContent = 'NSP inte konfigurerad (.env)';
    } else if (r.tokenOk) {
      badge.className = 'badge bg-green-lt align-self-center';
      badge.textContent = 'NSP ansluten';
    } else {
      badge.className = 'badge bg-red-lt align-self-center';
      badge.textContent = 'autentisering misslyckades';
    }
  } catch {
    badge.className = 'badge bg-red-lt align-self-center';
    badge.textContent = 'proxy ej tillgänglig';
  }
}

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = trError(msg);
  el.classList.remove('d-none');
}

async function loadOverview() {
  let data;
  try {
    const res = await fetch('/api/overview');
    data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
  } catch (e) {
    showError('Kunde inte ladda NSP-data: ' + trError(e.message));
    return;
  }

  document.getElementById('stat-total').textContent = (data.total ?? 0).toLocaleString(LOCALE);
  document.getElementById('stat-open').textContent = (data.open ?? 0).toLocaleString(LOCALE);
  document.getElementById('stat-closed').textContent = (data.closed ?? 0).toLocaleString(LOCALE);
  document.getElementById('stat-recent').textContent = (data.last30Days ?? 0).toLocaleString(LOCALE);

  const trend = data.trend || {};
  const trendDays = Object.keys(trend).sort();

  new ApexCharts(document.getElementById('chart-trend'), {
    chart: { type: 'area', height: 260, toolbar: { show: false }, animations: { enabled: false } },
    series: [{ name: 'Skapade', data: trendDays.map(d => trend[d]) }],
    xaxis: { categories: trendDays, labels: { rotate: -45, style: { fontSize: '10px' } } },
    stroke: { curve: 'smooth', width: 2 },
    fill: { type: 'gradient', gradient: { opacityFrom: 0.5, opacityTo: 0 } },
    colors: ['#206bc4'],
    dataLabels: { enabled: false },
    grid: { strokeDashArray: 4 },
  }).render();

  const statusEntries = Object.entries(data.byStatus || {}).sort((a, b) => b[1] - a[1]);
  new ApexCharts(document.getElementById('chart-status'), {
    chart: { type: 'donut', height: 260 },
    series: statusEntries.map(([, v]) => v),
    labels: statusEntries.map(([k]) => trStatus(k)),
    legend: { position: 'bottom' },
    dataLabels: { enabled: false },
  }).render();

  // Per-group breakdown by status (open statuses only). Build a stacked bar:
  // one series per status, categories = groups (sorted by total open desc).
  const groups = Object.entries(data.byAgentGroup || {})
    .map(([name, statusCounts]) => ({
      name,
      statusCounts,
      total: Object.values(statusCounts).reduce((s, v) => s + v, 0),
    }))
    .filter(g => g.total > 0)
    .sort((a, b) => b.total - a.total);

  const statusNames = [...new Set(groups.flatMap(g => Object.keys(g.statusCounts)))];
  const palette = ['#2fb344', '#206bc4', '#f59f00', '#ae3ec9', '#d63939', '#4299e1', '#74b816', '#fab005'];
  const series = statusNames.map(s => ({
    name: trStatus(s),
    data: groups.map(g => g.statusCounts[s] || 0),
  }));

  new ApexCharts(document.getElementById('chart-agentgroup'), {
    chart: { type: 'bar', stacked: true, height: Math.max(260, 32 * groups.length + 80), toolbar: { show: false } },
    series,
    colors: statusNames.map((_, i) => palette[i % palette.length]),
    xaxis: { categories: groups.map(g => g.name) },
    plotOptions: { bar: { horizontal: true, borderRadius: 2 } },
    dataLabels: { enabled: false },
    legend: { position: 'top' },
    grid: { strokeDashArray: 4 },
  }).render();

  renderClosedWeek(data.closedLastWeek || { days: [], groups: [], counts: {} });
  renderReadyToClose(data.readyToClose || []);

  const tbody = document.getElementById('agentgroup-stats');
  const avg = data.avgCloseHoursByGroup || {};
  tbody.innerHTML = groups.map(g => `
    <tr>
      <td>${escapeHtml(g.name)}</td>
      <td class="text-end">${g.total.toLocaleString(LOCALE)}</td>
      <td class="text-end text-muted">${formatHours(avg[g.name])}</td>
    </tr>
  `).join('');
}

function renderClosedWeek({ days, groups, counts }) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const yesterdayStr = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
  const dayLabel = d => d === todayStr ? 'Idag' : d === yesterdayStr ? 'Igår' : d;

  const header = `<thead><tr><th>Dag</th>${groups.map(g => `<th class="text-end">${escapeHtml(g)}</th>`).join('')}<th class="text-end">Totalt</th></tr></thead>`;
  const rows = days.map(d => {
    const dayCounts = counts[d] || {};
    const total = groups.reduce((s, g) => s + (dayCounts[g] || 0), 0);
    return `
      <tr>
        <td>${dayLabel(d)}</td>
        ${groups.map(g => `<td class="text-end ${dayCounts[g] ? '' : 'text-muted'}">${(dayCounts[g] || 0).toLocaleString(LOCALE)}</td>`).join('')}
        <td class="text-end fw-bold">${total.toLocaleString(LOCALE)}</td>
      </tr>
    `;
  }).join('');
  document.getElementById('closed-week-table').innerHTML = header + `<tbody>${rows}</tbody>`;
}

function renderReadyToClose(rows) {
  const card = document.getElementById('ready-to-close-card');
  if (!rows.length) {
    card.classList.add('d-none');
    return;
  }
  card.classList.remove('d-none');
  const word = rows.length === 1 ? 'ärende' : 'ärenden';
  document.getElementById('ready-count').textContent = `${rows.length} ${word}`;
  const tbody = document.getElementById('ready-to-close');
  const now = Date.now();
  tbody.innerHTML = rows.map(r => {
    const ageMs = r.created ? now - new Date(r.created).getTime() : null;
    const ageH = ageMs != null && Number.isFinite(ageMs) ? ageMs / 3_600_000 : null;
    return `
      <tr>
        <td><span class="fw-bold">${escapeHtml(r.ref || '—')}</span></td>
        <td>${escapeHtml(r.group)}</td>
        <td class="text-end text-muted">${formatHours(ageH)}</td>
      </tr>
    `;
  }).join('');
}

function formatHours(h) {
  if (h == null || !Number.isFinite(h)) return '—';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1).replace('.', ',')} tim`;
  const days = h / 24;
  if (days < 60) return `${days.toFixed(1).replace('.', ',')} d`;
  return `${(days / 30.44).toFixed(1).replace('.', ',')} mån`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadUser() {
  let me;
  try { me = await fetch('/api/me').then(r => r.json()); } catch { return; }
  const label = document.getElementById('user-label');
  const btnLogin = document.getElementById('btn-login');
  const btnLogout = document.getElementById('btn-logout');
  if (me.loggedIn) {
    label.textContent = me.email;
    label.classList.remove('d-none');
    btnLogout.classList.remove('d-none');
    btnLogin.classList.add('d-none');
  } else {
    label.classList.add('d-none');
    btnLogout.classList.add('d-none');
    btnLogin.classList.remove('d-none');
  }
}

document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  const errBox = document.getElementById('login-error');
  errBox.classList.add('d-none');
  const fd = new FormData(form);
  const body = JSON.stringify({ email: fd.get('email'), password: fd.get('password') });
  let res, data;
  try {
    res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    data = await res.json();
  } catch {
    errBox.textContent = 'Fel';
    errBox.classList.remove('d-none');
    return;
  }
  if (!res.ok) {
    errBox.textContent = 'Fel';
    errBox.classList.remove('d-none');
    return;
  }
  // Ask the browser to offer saving the credentials. Without this, fetch+preventDefault
  // doesn't reliably trigger Chrome's save-password prompt.
  if (window.PasswordCredential) {
    try {
      const cred = new window.PasswordCredential({
        id: fd.get('email'),
        password: fd.get('password'),
        name: fd.get('email'),
      });
      await navigator.credentials.store(cred);
    } catch { /* user dismissed or unsupported */ }
  }
  window.location.reload();
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.reload();
});

loadUser();
loadHealth();
loadOverview();
