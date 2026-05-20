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
}

loadHealth();
loadOverview();
