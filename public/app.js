const OPEN_STATUSES = new Set(['New', 'Open', 'Assigned', 'In Progress', 'Active', 'Reopened']);
const CLOSED_STATUSES = new Set(['Closed', 'Resolved', 'Cancelled', 'Canceled', 'Released']);

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

  document.getElementById('stat-total').textContent = data.total ?? '0';

  let open = 0, closed = 0;
  for (const [name, count] of Object.entries(data.byStatus || {})) {
    if (CLOSED_STATUSES.has(name)) closed += count;
    else if (OPEN_STATUSES.has(name)) open += count;
  }
  document.getElementById('stat-open').textContent = open;
  document.getElementById('stat-closed').textContent = closed;

  const trend = data.trend || {};
  const trendDays = Object.keys(trend).sort();
  const recentTotal = trendDays.reduce((s, d) => s + trend[d], 0);
  document.getElementById('stat-recent').textContent = recentTotal;

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

  const typeEntries = Object.entries(data.byType || {}).sort((a, b) => b[1] - a[1]);
  new ApexCharts(document.getElementById('chart-type'), {
    chart: { type: 'bar', height: 260, toolbar: { show: false } },
    series: [{ name: 'Count', data: typeEntries.map(([, v]) => v) }],
    xaxis: { categories: typeEntries.map(([k]) => k) },
    colors: ['#4299e1'],
    dataLabels: { enabled: true },
    plotOptions: { bar: { borderRadius: 4, horizontal: false } },
  }).render();
}

loadHealth();
loadOverview();
