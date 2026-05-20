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

  renderAgentGroups(data.byAgentGroup || {});
}

function renderAgentGroups(groups) {
  const entries = Object.entries(groups).sort((a, b) => b[1].total - a[1].total);
  const max = entries.reduce((m, [, v]) => Math.max(m, v.total), 0) || 1;

  const container = document.getElementById('agentgroup-list');
  container.innerHTML = entries.map(([name, v]) => {
    const widthPct = (v.total / max) * 100;
    const openPct = v.total ? (v.open / v.total) * 100 : 0;
    const closedPct = v.total ? (v.closed / v.total) * 100 : 0;
    return `
      <div class="mb-3">
        <div class="d-flex align-items-baseline mb-1">
          <strong class="me-2">${escapeHtml(name)}</strong>
          <span class="text-muted small">${v.total.toLocaleString()} tickets</span>
          <span class="ms-auto small">
            <span class="text-green me-3">Open ${v.open.toLocaleString()}</span>
            <span class="text-blue">Closed ${v.closed.toLocaleString()}</span>
          </span>
        </div>
        <div class="progress" style="height: 12px; width: ${widthPct}%; min-width: 4px;">
          <div class="progress-bar bg-green" style="width: ${openPct}%" title="Open ${v.open}"></div>
          <div class="progress-bar bg-blue" style="width: ${closedPct}%" title="Closed ${v.closed}"></div>
        </div>
      </div>
    `;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

loadHealth();
loadOverview();
