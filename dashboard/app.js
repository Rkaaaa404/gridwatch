/**
 * GridWatch Dashboard — app.js
 * Real-time WebSocket + Leaflet map + Chart.js
 * Connects to dashboard-subscriber WebSocket bridge
 */

// ─── Config ───────────────────────────────────────────────────────────────────
const WS_URL = 'ws://localhost:8080';

// Node definitions: koordinat Surabaya
const NODES = {
  'gardu-induk': {
    label: 'Gardu Induk',
    icon: 'GI',
    lat: -7.2975, lng: 112.7440,
    area: 'Surabaya Pusat',
    level: '150kV → 20kV',
    role: 'Root Node',
    upstream: null,
    color: '#3b82f6',
  },
  'trafo-a': {
    label: 'Trafo A',
    icon: 'TA',
    lat: -7.2647, lng: 112.7547,
    area: 'Gubeng',
    level: '20kV → 380V',
    role: 'Feeder Area Residensial',
    upstream: 'gardu-induk',
    color: '#06b6d4',
  },
  'trafo-b': {
    label: 'Trafo B',
    icon: 'TB',
    lat: -7.2889, lng: 112.7347, // Darmo
    area: 'Perumahan Darmo',
    level: '20kV → 380V',
    role: 'Blok Perumahan 1',
    upstream: 'trafo-a',
    color: '#8b5cf6',
  },
  'trafo-c': {
    label: 'Trafo C',
    icon: 'TC',
    lat: -7.3188, lng: 112.7388, // Margorejo
    area: 'Perumahan Margorejo',
    level: '20kV → 220V',
    role: 'Blok Perumahan 2',
    upstream: 'trafo-a',
    color: '#f59e0b',
  },
};

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  nodes: {},           // nodeId -> { status, sensors: {} }
  selectedNode: null,
  ws: null,
  msgCount: 0,
  msgRateWindow: [],
  alarmCount: 0,
  charts: {},
  chartData: {},       // nodeId -> { tegangan: [], arus: [], suhu: [], beban: [], labels: [] }
};

// Init node state
Object.keys(NODES).forEach(id => {
  state.nodes[id] = {
    status: 'UNKNOWN',
    lastSeen: null,
    sensors: { tegangan: '--', arus: '--', suhu: '--', beban: '--', daya: '--' },
  };
  state.chartData[id] = { labels: [], tegangan: [], arus: [], suhu: [], beban: [] };
});

// ─── Map Init ─────────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: false, attributionControl: false }).setView([-7.295, 112.752], 13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
}).addTo(map);

L.control.zoom({ position: 'bottomright' }).addTo(map);

// Markers & polylines
const markers = {};
const polylines = {};

// ─── Create Markers ───────────────────────────────────────────────────────────
Object.entries(NODES).forEach(([id, node]) => {
  const icon = L.divIcon({
    className: '',
    html: `<div class="grid-marker status-UNKNOWN" id="marker-${id}" title="${node.label}">${node.icon}</div>`,
    iconSize: [52, 52],
    iconAnchor: [26, 26],
    popupAnchor: [0, -30],
  });

  const marker = L.marker([node.lat, node.lng], { icon }).addTo(map);
  marker.bindPopup('', { maxWidth: 280, className: 'gridwatch-popup' });
  marker.on('click', () => selectNode(id));
  markers[id] = marker;
});

// ─── Connection Lines ─────────────────────────────────────────────────────────
function getStatusColor(status) {
  const colors = {
    NORMAL: '#10b981', WARNING: '#f59e0b', FAULT: '#ef4444',
    NO_POWER: '#4b5563', OFFLINE: '#4b5563', ISOLATED: '#8b5cf6', UNKNOWN: '#374151',
  };
  return colors[status] || '#374151';
}

function updatePolylines() {
  // Remove existing
  Object.values(polylines).forEach(p => map.removeLayer(p));

  Object.entries(NODES).forEach(([id, node]) => {
    if (!node.upstream) return;
    const upId = node.upstream;
    const downStatus = state.nodes[id]?.status || 'UNKNOWN';
    const upStatus = state.nodes[upId]?.status || 'UNKNOWN';

    // Kabel warnanya = status yang lebih buruk antara up & down
    const priorityOrder = ['FAULT', 'OFFLINE', 'NO_POWER', 'ISOLATED', 'WARNING', 'NORMAL', 'UNKNOWN'];
    const worstStatus = [downStatus, upStatus].sort((a, b) => priorityOrder.indexOf(a) - priorityOrder.indexOf(b))[0];
    const color = getStatusColor(worstStatus);
    const opacity = worstStatus === 'NORMAL' ? 0.7 : 0.9;
    const weight = worstStatus === 'FAULT' ? 4 : 2.5;
    const dashArray = ['OFFLINE', 'NO_POWER'].includes(worstStatus) ? '6, 6' : null;

    const line = L.polyline(
      [[NODES[upId].lat, NODES[upId].lng], [NODES[id].lat, NODES[id].lng]],
      { color, weight, opacity, dashArray }
    ).addTo(map);

    line.bindTooltip(`${NODES[upId].label} → ${node.label} | ${worstStatus}`, { sticky: true });
    polylines[id] = line;
  });
}

updatePolylines();

// ─── WebSocket ────────────────────────────────────────────────────────────────
function connectWS() {
  const ws = new WebSocket(WS_URL);
  state.ws = ws;

  ws.onopen = () => {
    setBadge('connected', 'WS Connected');
    addLog('INFO', 'dashboard', 'WebSocket connected ke DashboardSubscriber');
  };

  ws.onclose = () => {
    setBadge('disconnected', '🔴 Disconnected');
    addLog('WARNING', 'dashboard', 'WebSocket disconnected — retry in 3s...');
    setTimeout(connectWS, 3000);
  };

  ws.onerror = () => {
    setBadge('disconnected', 'WS Error');
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWsMessage(msg);
    } catch (e) {}
  };
}

function handleWsMessage(msg) {
  if (msg.type === 'PING') return;

  if (msg.type === 'STATE_SNAPSHOT') {
    // Terima snapshot state dari server
    Object.entries(msg.data).forEach(([nodeId, nodeData]) => {
      Object.entries(nodeData).forEach(([dataType, payload]) => {
        processNodeUpdate(nodeId, dataType, payload);
      });
    });
    return;
  }

  if (msg.type === 'MQTT_MESSAGE') {
    state.msgCount++;
    state.msgRateWindow.push(Date.now());

    const { nodeId, dataType, payload } = msg;
    if (nodeId && dataType) {
      processNodeUpdate(nodeId, dataType, payload);
    }
  }
}

function processNodeUpdate(nodeId, dataType, payload) {
  if (!state.nodes[nodeId]) return;

  const node = state.nodes[nodeId];

  if (dataType === 'status') {
    const prevStatus = node.status;
    node.status = payload.status || node.status;
    node.lastSeen = payload.timestamp;

    if (prevStatus !== node.status) {
      handleStatusChange(nodeId, prevStatus, node.status, payload);
    }

    updateMarker(nodeId);
    updatePolylines();
    updateNodeCard(nodeId);
    updateStats();
  }

  if (dataType === 'lwt') {
    if (payload.status === 'OFFLINE') {
      const prev = node.status;
      node.status = 'OFFLINE';
      handleStatusChange(nodeId, prev, 'OFFLINE', payload);
      updateMarker(nodeId);
      updatePolylines();
      updateNodeCard(nodeId);
    }
  }

  if (dataType === 'alarm') {
    state.alarmCount++;
    const level = payload.level === 'CRITICAL' ? 'CRITICAL' : 'WARNING';
    addLog(level, nodeId, payload.message);
    showToast(level === 'CRITICAL' ? 'toast-critical' : 'toast-warning',
      `${level}: [${nodeId}] ${payload.message}`);
    updateAlarmBadge();
  }

  // Update sensor data
  if (['tegangan', 'arus', 'suhu', 'beban', 'daya'].includes(dataType)) {
    node.sensors[dataType] = payload.value !== undefined ? payload.value : '--';
    updateNodeCard(nodeId);

    // Tambah data ke chart history
    if (dataType !== 'daya' && payload.value !== undefined) {
      const cd = state.chartData[nodeId];
      const label = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      if (!cd.labels.includes(label) || cd.labels.length === 0) {
        cd.labels.push(label);
        cd[dataType].push(payload.value);
        // Keep max 30 data points
        if (cd.labels.length > 30) {
          cd.labels.shift();
          ['tegangan', 'arus', 'suhu', 'beban'].forEach(k => { if (cd[k].length > 30) cd[k].shift(); });
        }
      } else {
        // Update last point
        const lastIdx = cd.labels.length - 1;
        cd[dataType][lastIdx] = payload.value;
      }

      if (state.selectedNode === nodeId) {
        updateCharts(nodeId);
      }
    }
  }

  if (dataType === 'ack') {
    addLog('INFO', nodeId, `ACK: ${payload.command} → status: ${payload.status}`);
  }
}

function handleStatusChange(nodeId, prev, next, payload) {
  const nodeLabel = NODES[nodeId]?.label || nodeId;

  const level = ['FAULT', 'NO_POWER', 'OFFLINE'].includes(next) ? 'CRITICAL' : next === 'WARNING' ? 'WARNING' : 'INFO';
  addLog(level, nodeId, `Status berubah: ${prev} → ${next}`);

  if (next === 'FAULT') {
    showToast('toast-critical', `FAULT: ${nodeLabel} — fault terdeteksi! Cascade analysis running...`);
  } else if (next === 'NO_POWER') {
    showToast('toast-warning', `NO_POWER: ${nodeLabel} — kehilangan daya dari upstream`);
  } else if (next === 'OFFLINE') {
    showToast('toast-critical', `OFFLINE: ${nodeLabel} — LWT triggered! Node disconnected.`);
  } else if (next === 'NORMAL' && ['FAULT', 'NO_POWER', 'OFFLINE'].includes(prev)) {
    showToast('toast-info', `RECOVER: ${nodeLabel} — kembali normal`);
  }
}

// ─── Marker Update ────────────────────────────────────────────────────────────
function updateMarker(nodeId) {
  const status = state.nodes[nodeId]?.status || 'UNKNOWN';
  const el = document.getElementById(`marker-${nodeId}`);
  if (!el) return;

  // Remove all status classes
  el.className = el.className.replace(/status-\S+/g, '').trim();
  el.classList.add(`grid-marker`, `status-${status}`);
}

// ─── Node Cards ───────────────────────────────────────────────────────────────
function renderNodeCards() {
  const panel = document.getElementById('nodes-panel');
  panel.innerHTML = '';

  Object.entries(NODES).forEach(([id, node]) => {
    const div = document.createElement('div');
    div.className = 'node-card';
    div.id = `card-${id}`;
    div.onclick = () => selectNode(id);
    div.innerHTML = getNodeCardHTML(id, node);
    panel.appendChild(div);
  });
}

function formatNumber(val) {
  if (val === '--' || isNaN(val)) return '--';
  return Number(val).toLocaleString('id-ID', { maximumFractionDigits: 2 });
}

function getNodeCardHTML(id, node) {
  const n = state.nodes[id];
  const status = n.status;
  const sensors = n.sensors;
  return `
    <div class="node-card-header">
      <div class="node-card-title">
        <div class="status-dot ${status}"></div>
        <span>${node.label}</span>
      </div>
      <span class="status-badge ${status}">${status}</span>
    </div>
    <div style="font-size:10px;color:var(--text-muted);margin-bottom:6px">${node.area} · ${node.level}</div>
    <div class="node-metrics">
      <div class="metric-mini"><span class="m-label">Tegangan</span><span class="m-value">${sensors.tegangan !== '--' ? formatNumber(sensors.tegangan) + 'V' : '--'}</span></div>
      <div class="metric-mini"><span class="m-label">Beban</span><span class="m-value">${sensors.beban !== '--' ? formatNumber(sensors.beban) + '%' : '--'}</span></div>
      <div class="metric-mini"><span class="m-label">Suhu</span><span class="m-value">${sensors.suhu !== '--' ? formatNumber(sensors.suhu) + '°' : '--'}</span></div>
    </div>
  `;
}

function updateNodeCard(nodeId) {
  const card = document.getElementById(`card-${nodeId}`);
  if (!card) return;
  card.innerHTML = getNodeCardHTML(nodeId, NODES[nodeId]);
  if (state.selectedNode === nodeId) card.classList.add('selected');
}

// ─── Select Node ──────────────────────────────────────────────────────────────
function selectNode(nodeId) {
  state.selectedNode = nodeId;

  // Update card selection
  document.querySelectorAll('.node-card').forEach(c => c.classList.remove('selected'));
  const card = document.getElementById(`card-${nodeId}`);
  if (card) card.classList.add('selected');

  // Update popup
  const node = NODES[nodeId];
  const ns = state.nodes[nodeId];
  const sensors = ns.sensors;

  const popupHTML = `
    <div class="node-popup">
      <h3>${node.label} <span class="status-badge ${ns.status}">${ns.status}</span></h3>
      <div style="font-size:11px;color:#94a3b8;margin-bottom:8px">${node.area} · ${node.role}</div>
      <div class="sensor-grid">
        <div class="sensor-item">
          <span class="label">Tegangan</span>
          <span class="value">${sensors.tegangan !== '--' ? formatNumber(sensors.tegangan) + 'V' : '—'}</span>
        </div>
        <div class="sensor-item">
          <span class="label">Arus</span>
          <span class="value">${sensors.arus !== '--' ? formatNumber(sensors.arus) + 'A' : '—'}</span>
        </div>
        <div class="sensor-item">
          <span class="label">Suhu</span>
          <span class="value">${sensors.suhu !== '--' ? formatNumber(sensors.suhu) + '°C' : '—'}</span>
        </div>
        <div class="sensor-item">
          <span class="label">Beban</span>
          <span class="value">${sensors.beban !== '--' ? formatNumber(sensors.beban) + '%' : '—'}</span>
        </div>
      </div>
      <div style="font-size:10px;color:#475569;margin-bottom:8px">Last seen: ${ns.lastSeen ? new Date(ns.lastSeen).toLocaleTimeString('id-ID') : 'never'}</div>
      <div class="popup-actions">
        <button class="popup-btn fault"   onclick="sendCommandTo('${nodeId}','FAULT')">FAULT</button>
        <button class="popup-btn trip"    onclick="sendCommandTo('${nodeId}','TRIP')">TRIP</button>
        <button class="popup-btn isolate" onclick="sendCommandTo('${nodeId}','ISOLATE')">ISOLATE</button>
        <button class="popup-btn reset"   onclick="sendCommandTo('${nodeId}','RESET')">RESET</button>
      </div>
    </div>
  `;

  markers[nodeId].openPopup();
  markers[nodeId].setPopupContent(popupHTML);

  // Switch to charts tab and update
  switchTab('charts');
  document.getElementById('chart-node-label').textContent = `${node.label} — Tegangan (V)`;
  updateCharts(nodeId);
}

// ─── Charts ───────────────────────────────────────────────────────────────────
const CHART_COLORS = {
  tegangan: '#3b82f6',
  arus:     '#06b6d4',
  suhu:     '#f97316',
  beban:    '#10b981',
};

function createChart(canvasId, label, color) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label,
        data: [],
        borderColor: color,
        backgroundColor: color + '18',
        borderWidth: 2,
        pointRadius: 2,
        pointHoverRadius: 4,
        fill: true,
        tension: 0.4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: '#475569', font: { size: 9 }, maxRotation: 0, maxTicksLimit: 5 },
          grid: { color: 'rgba(255,255,255,0.04)' },
        },
        y: {
          ticks: { color: '#475569', font: { size: 9 } },
          grid: { color: 'rgba(255,255,255,0.04)' },
        },
      },
    },
  });
}

function initCharts() {
  state.charts.tegangan = createChart('chart-tegangan', 'Tegangan (V)', CHART_COLORS.tegangan);
  state.charts.arus      = createChart('chart-arus', 'Arus (A)',      CHART_COLORS.arus);
  state.charts.suhu      = createChart('chart-suhu', 'Suhu (°C)',     CHART_COLORS.suhu);
  state.charts.beban     = createChart('chart-beban', 'Beban (%)',    CHART_COLORS.beban);
}

function updateCharts(nodeId) {
  const cd = state.chartData[nodeId];
  ['tegangan', 'arus', 'suhu', 'beban'].forEach(key => {
    const chart = state.charts[key];
    if (!chart) return;
    chart.data.labels = [...cd.labels];
    chart.data.datasets[0].data = [...cd[key]];
    chart.update('none');
  });
}

// ─── Stats & UI Updates ───────────────────────────────────────────────────────
function updateStats() {
  const now = Date.now();
  state.msgRateWindow = state.msgRateWindow.filter(t => now - t < 1000);
  document.getElementById('msg-rate').textContent = state.msgRateWindow.length;
  document.getElementById('msg-total').textContent = state.msgCount;

  const online = Object.values(state.nodes).filter(n => ['NORMAL', 'WARNING', 'ISOLATED'].includes(n.status)).length;
  document.getElementById('nodes-online').textContent = `${online}/4`;
}

function updateAlarmBadge() {
  document.getElementById('alarm-count').textContent = state.alarmCount;
  document.getElementById('alarm-badge').textContent = `${state.alarmCount} alarms`;
}

// ─── Log ──────────────────────────────────────────────────────────────────────
const MAX_LOG = 100;
let logCount = 0;

function addLog(level, nodeId, message) {
  const container = document.getElementById('log-scroll');
  const time = new Date().toLocaleTimeString('id-ID');
  const icons = { CRITICAL: 'CRIT', WARNING: 'WARN', CASCADE: 'CASC', OFFLINE: 'OFFL', INFO: 'INFO' };
  const icon = icons[level] || 'INFO';

  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  entry.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-icon">${icon}</span>
    <span class="log-node">${nodeId}</span>
    <span class="log-msg">${message}</span>
  `;

  container.prepend(entry);
  logCount++;

  // Limit log entries
  while (container.children.length > MAX_LOG) {
    container.removeChild(container.lastChild);
  }

  // Update alarm badge for critical entries
  if (level === 'CRITICAL' || level === 'CASCADE') {
    updateAlarmBadge();
  }
}

function clearLog() {
  document.getElementById('log-scroll').innerHTML = '';
  state.alarmCount = 0;
  logCount = 0;
  updateAlarmBadge();
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(type, message) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span style="flex:1;font-size:11px">${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// ─── Control Panel ────────────────────────────────────────────────────────────
function sendCommand(command) {
  const nodeId = document.getElementById('ctrl-node-select').value;
  sendCommandTo(nodeId, command);
}

function sendCommandTo(nodeId, command) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showToast('toast-warning', '⚠️ WebSocket tidak terhubung — command tidak terkirim');
    return;
  }

  const payload = {
    type: 'SEND_COMMAND',
    nodeId,
    command,
    timestamp: new Date().toISOString(),
  };

  state.ws.send(JSON.stringify(payload));
  addLog('INFO', nodeId, `Command dikirim: ${command} (QoS 2)`);
  showToast('toast-info', `Command ${command} → ${nodeId} (QoS 2)`);
}

// ─── WebSocket Badge ──────────────────────────────────────────────────────────
function setBadge(type, text) {
  const badge = document.getElementById('ws-badge');
  badge.className = `connection-badge ${type}`;
  document.getElementById('ws-status-text').textContent = text;
}

// ─── Tab switching ────────────────────────────────────────────────────────────
function switchTab(tabName) {
  document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));

  document.getElementById(`tab-${tabName}`).classList.add('active');
  document.getElementById(`${tabName}-panel`).classList.add('active');
}

// ─── Clock ────────────────────────────────────────────────────────────────────
function updateClock() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('id-ID', { hour12: false });
}

// ─── Periodic UI refresh ──────────────────────────────────────────────────────
setInterval(() => {
  updateStats();
  // Re-render cards periodically for last-seen freshness
  Object.keys(NODES).forEach(id => updateNodeCard(id));
}, 2000);

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initCharts();
  renderNodeCards();
  connectWS();
  setInterval(updateClock, 1000);
  updateClock();

  addLog('INFO', 'system', 'GridWatch Dashboard initialized');
  addLog('INFO', 'system', 'Menunggu koneksi WebSocket ke DashboardSubscriber...');
});
