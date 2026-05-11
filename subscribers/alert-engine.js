/**
 * GridWatch — AlertEngine Subscriber
 * Role: Anomaly detection, cascade identification, alert routing
 * Subscribe: gridwatch/+/status, gridwatch/+/alarm, gridwatch/+/lwt
 * Persistent session: cleanSession false → tidak lewatkan QoS 1/2 saat reconnect
 * Mendeteksi root cause dari cascade fault
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = 'subscriber-alert-engine'; // Fixed ID untuk persistent session
const BROKER = process.env.MQTT_BROKER || 'mqtt://broker.emqx.io:1883';

// Log file untuk audit trail
const LOG_DIR = path.join(__dirname, '../logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, `alert-${new Date().toISOString().slice(0, 10)}.log`);

console.log(`\n🚨 [AlertEngine] Starting — Persistent session mode`);
console.log(`📝 Log file: ${LOG_FILE}\n`);

const connectOptions = {
  clientId: CLIENT_ID,
  clean: false, // Persistent session!
  connectTimeout: 10000,
  reconnectPeriod: 3000,
};
if (process.env.MQTT_USERNAME) connectOptions.username = process.env.MQTT_USERNAME;
if (process.env.MQTT_PASSWORD) connectOptions.password = process.env.MQTT_PASSWORD;

const client = mqtt.connect(BROKER, connectOptions);

// ─── State Monitoring ─────────────────────────────────────────────────────────
const nodeStatus = {
  'gardu-induk': { status: 'UNKNOWN', lastSeen: null },
  'trafo-a':     { status: 'UNKNOWN', lastSeen: null },
  'trafo-b':     { status: 'UNKNOWN', lastSeen: null },
  'trafo-c':     { status: 'UNKNOWN', lastSeen: null },
};

const alertHistory = []; // In-memory alert log

// ─── Logging ──────────────────────────────────────────────────────────────────
function logAlert(level, nodeId, message, extra = {}) {
  const ts = new Date().toISOString();
  const entry = { ts, level, nodeId, message, ...extra };
  alertHistory.push(entry);

  // Keep max 200 alerts in memory
  if (alertHistory.length > 200) alertHistory.shift();

  // Write to log file
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');

  const icon = level === 'CRITICAL' ? '🔴' : level === 'CASCADE' ? '🟠' : level === 'OFFLINE' ? '⚫' : '🟡';
  console.log(`${icon} [AlertEngine] [${level}] ${nodeId}: ${message}`);
}

// ─── Cascade Root Cause Analysis ─────────────────────────────────────────────
function analyzeCascade(faultedNodeId) {
  const chain = ['gardu-induk', 'trafo-a', 'trafo-b', 'trafo-c'];
  const faultIndex = chain.indexOf(faultedNodeId);

  if (faultIndex === -1) return;

  const downstream = chain.slice(faultIndex + 1);
  if (downstream.length === 0) {
    logAlert('CRITICAL', faultedNodeId, `FAULT terdeteksi — node akhir, tidak ada cascade downstream`, { type: 'root-cause' });
    return;
  }

  logAlert('CASCADE', faultedNodeId, `ROOT CAUSE IDENTIFIED — cascade akan mempengaruhi: ${downstream.join(', ')}`, { downstream, type: 'cascade-analysis' });

  downstream.forEach(downId => {
    const currentStatus = nodeStatus[downId]?.status;
    logAlert('CASCADE', downId, `Prediksi akan menjadi NO_POWER karena fault di ${faultedNodeId}`, {
      rootCause: faultedNodeId,
      currentStatus,
      type: 'cascade-prediction',
    });
  });
}

// ─── Alert Rules ──────────────────────────────────────────────────────────────
function checkAlertRules(nodeId, payload, topic) {
  const { status, value, unit } = payload;

  // Rule 1: Status FAULT — identifikasi cascade
  if (status === 'FAULT') {
    logAlert('CRITICAL', nodeId, `Status FAULT — trigger cascade analysis`, { status });
    analyzeCascade(nodeId);
  }

  // Rule 2: Status NO_POWER — identifikasi root cause
  if (status === 'NO_POWER') {
    const upstreamStatus = payload.upstreamStatus;
    logAlert('CASCADE', nodeId, `NO_POWER — karena upstream: ${upstreamStatus}`, { status, upstreamStatus });
  }

  // Rule 3: Tegangan anomali (±10% dari nominal)
  if (topic.includes('/tegangan') && value !== undefined) {
    let nominalMap = { 'gardu-induk': 20000, 'trafo-a': 380, 'trafo-b': 380, 'trafo-c': 220 };
    const nominal = nominalMap[nodeId];
    if (nominal && value > 0) {
      const deviation = Math.abs(value - nominal) / nominal * 100;
      if (deviation > 10) {
        logAlert('WARNING', nodeId, `Tegangan anomali: ${value}${unit} (deviasi ${deviation.toFixed(1)}% dari nominal ${nominal}${unit})`);
      }
    }
  }

  // Rule 4: Suhu > 80°C
  if (topic.includes('/suhu') && value !== undefined && value > 80) {
    logAlert('WARNING', nodeId, `Suhu kritis: ${value}°C — risiko overheating!`);
  }

  // Rule 5: Beban > 90%
  if (topic.includes('/beban') && value !== undefined && value > 90) {
    logAlert('WARNING', nodeId, `Beban kritis: ${value}% — mendekati kapasitas maksimum!`);
  }
}

// ─── Event Handlers ───────────────────────────────────────────────────────────
client.on('connect', (connack) => {
  console.log(`✅ [AlertEngine] Connected! Persistent session: ${!connack.sessionPresent ? 'new' : 'resumed'}`);

  // Subscribe dengan wildcard + — semua node sekaligus
  // Ini demonstrasi penggunaan wildcard single-level +
  client.subscribe('gridwatch/+/status', { qos: 1 }, (err) => {
    if (!err) console.log(`📥 [AlertEngine] Subscribed to gridwatch/+/status (wildcard QoS 1)`);
  });

  client.subscribe('gridwatch/+/alarm', { qos: 2 }, (err) => {
    if (!err) console.log(`📥 [AlertEngine] Subscribed to gridwatch/+/alarm (wildcard QoS 2)`);
  });

  client.subscribe('gridwatch/+/lwt', { qos: 1 }, (err) => {
    if (!err) console.log(`📥 [AlertEngine] Subscribed to gridwatch/+/lwt (wildcard QoS 1)`);
  });

  client.subscribe('gridwatch/kontrol/+/ack', { qos: 2 }, (err) => {
    if (!err) console.log(`📥 [AlertEngine] Subscribed to gridwatch/kontrol/+/ack`);
  });

  // Semua sensor untuk anomaly detection
  client.subscribe('gridwatch/+/tegangan', { qos: 0 }, () => {});
  client.subscribe('gridwatch/+/suhu', { qos: 0 }, () => {});
  client.subscribe('gridwatch/+/beban', { qos: 0 }, () => {});

  console.log(`\n🔍 [AlertEngine] Monitoring aktif — menunggu data...\n`);
});

client.on('message', (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    const parts = topic.split('/');

    // Extract nodeId dari topic: gridwatch/{nodeId}/...
    // Tapi perlu handle gridwatch/kontrol/{nodeId}/ack
    let nodeId = parts[1];
    if (nodeId === 'kontrol') nodeId = parts[2];

    const subtopic = parts[parts.length - 1];

    // Update node status tracking
    if (subtopic === 'status' && payload.nodeId) {
      const prevStatus = nodeStatus[payload.nodeId]?.status;
      nodeStatus[payload.nodeId] = { status: payload.status, lastSeen: new Date().toISOString() };

      if (prevStatus !== payload.status) {
        console.log(`📊 [AlertEngine] Node ${payload.nodeId}: ${prevStatus} → ${payload.status}`);
      }
    }

    // LWT — node offline
    if (subtopic === 'lwt') {
      if (payload.status === 'OFFLINE') {
        logAlert('OFFLINE', payload.nodeId || nodeId, `LWT received — node disconnected unexpectedly!`, { type: 'lwt-offline' });
        if (nodeStatus[payload.nodeId]) {
          nodeStatus[payload.nodeId].status = 'OFFLINE';
        }
      }
      return;
    }

    // Alarm dari node (QoS 2)
    if (subtopic === 'alarm') {
      const alarmLevel = payload.level === 'CRITICAL' ? 'CRITICAL' : 'WARNING';
      logAlert(alarmLevel, payload.nodeId || nodeId, payload.message, { type: 'node-alarm', ...payload });
      return;
    }

    // ACK dari node
    if (subtopic === 'ack') {
      console.log(`✅ [AlertEngine] Command ACK: ${payload.nodeId} executed ${payload.command} → ${payload.status}`);
      return;
    }

    // Cek alert rules untuk semua topic
    checkAlertRules(payload.nodeId || nodeId, payload, topic);

  } catch (e) {
    // Silent — beberapa topic mungkin non-JSON
  }
});

// Periodic status report setiap 30 detik
setInterval(() => {
  console.log('\n📊 [AlertEngine] ── Status Report ──────────────────');
  Object.entries(nodeStatus).forEach(([id, info]) => {
    const icon = info.status === 'NORMAL' ? '🟢' : info.status === 'WARNING' ? '🟡' : info.status === 'FAULT' ? '🔴' : info.status === 'OFFLINE' ? '⚫' : '❓';
    console.log(`   ${icon} ${id.padEnd(15)} ${info.status} (last: ${info.lastSeen || 'never'})`);
  });
  console.log(`   Alerts logged: ${alertHistory.length} | Log: ${LOG_FILE}`);
  console.log('──────────────────────────────────────────────────\n');
}, 30000);

client.on('error', (err) => console.error(`❌ [AlertEngine] Error:`, err.message));
client.on('reconnect', () => console.log(`🔄 [AlertEngine] Reconnecting — persistent session akan resume...`));
client.on('offline', () => console.log(`📴 [AlertEngine] Offline — QoS 1/2 messages akan di-queue oleh broker`));

process.on('SIGINT', () => {
  console.log('\n🛑 [AlertEngine] Shutting down...');
  client.end();
  process.exit(0);
});
