async function loadHealth() {
  const badge = document.getElementById('health');
  try {
    const r = await fetch('/api/health').then(r => r.json());
    if (!r.nspConfigured) {
      badge.className = 'badge bg-yellow-lt align-self-center';
      badge.textContent = 'NSP not configured (.env)';
    } else if (r.tokenOk) {
      badge.className = 'badge bg-green-lt align-self-center';
      badge.textContent = 'NSP connected';
    } else {
      badge.className = 'badge bg-red-lt align-self-center';
      badge.textContent = 'auth failed';
    }
  } catch {
    badge.className = 'badge bg-red-lt align-self-center';
    badge.textContent = 'proxy offline';
  }
}

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.classList.remove('d-none');
}

async function loadOverview() {
  let data;
  try {
    const res = await fetch('/api/overview');
    data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
  } catch (e) {
    showError('Failed to load NSP data: ' + e.message);
    return;
  }

  document.getElementById('stat-total').textContent = (data.total ?? 0).toLocaleString();
  document.getElementById('stat-open').textContent = (data.open ?? 0).toLocaleString();
  document.getElementById('stat-closed').textContent = (data.closed ?? 0).toLocaleString();
  document.getElementById('stat-recent').textContent = (data.last30Days ?? 0).toLocaleString();

  const trend = data.trend || {};
  const trendDays = Object.keys(trend).sort();

  new ApexCharts(document.getElementById('chart-trend'), {
    chart: { type: 'area', height: 260, toolbar: { show: false }, animations: { enabled: false } },
    series: [{ name: 'Created', data: trendDays.map(d => trend[d]) }],
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
    labels: statusEntries.map(([k]) => k),
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
  const series = statusNames.map((s, i) => ({
    name: s,
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
      <td class="text-end">${g.total.toLocaleString()}</td>
      <td class="text-end text-muted">${formatHours(avg[g.name])}</td>
    </tr>
  `).join('');
}

function renderClosedWeek({ days, groups, counts }) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const yesterdayStr = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
  const dayLabel = d => d === todayStr ? 'Today' : d === yesterdayStr ? 'Yesterday' : d;

  const header = `<thead><tr><th>Day</th>${groups.map(g => `<th class="text-end">${escapeHtml(g)}</th>`).join('')}<th class="text-end">Total</th></tr></thead>`;
  const rows = days.map(d => {
    const dayCounts = counts[d] || {};
    const total = groups.reduce((s, g) => s + (dayCounts[g] || 0), 0);
    return `
      <tr>
        <td>${dayLabel(d)}</td>
        ${groups.map(g => `<td class="text-end ${dayCounts[g] ? '' : 'text-muted'}">${(dayCounts[g] || 0).toLocaleString()}</td>`).join('')}
        <td class="text-end fw-bold">${total.toLocaleString()}</td>
      </tr>
    `;
  }).join('');
  document.getElementById('closed-week-table').innerHTML = header + `<tbody>${rows}</tbody>`;
}

function renderReadyToClose(rows) {
  const badge = document.getElementById('ready-count');
  badge.textContent = `${rows.length} ticket${rows.length === 1 ? '' : 's'}`;
  const tbody = document.getElementById('ready-to-close');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="text-center text-muted py-3">None — nothing waiting to be closed.</td></tr>`;
    return;
  }
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
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  const days = h / 24;
  if (days < 60) return `${days.toFixed(1)}d`;
  return `${(days / 30.44).toFixed(1)}mo`;
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
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove('d-none');
    return;
  }
  if (!res.ok) {
    errBox.textContent = data.error || 'Login failed';
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
