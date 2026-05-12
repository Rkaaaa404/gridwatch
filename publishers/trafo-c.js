/**
 * GridWatch — TrafoC Publisher + Subscriber
 * Role: Distribusi Tepi Danau (Maninjau, Agam)
 * Subscribe ke: gridwatch/trafo-a/status
 * Cascade: Jika TrafoA FAULT/NO_POWER/ISOLATED/OFFLINE → NO_POWER
 * Status hanya berubah via command atau cascade
 * Note: SIGINT tanpa publish LWT manual → demonstrasikan LWT broker-triggered
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mqtt = require('mqtt');

const CLIENT_ID = 'publisher-trafo-c-' + Math.random().toString(16).slice(2, 6);
const NODE_ID = 'trafo-c';
const UPSTREAM = 'trafo-a';
const BROKER = process.env.MQTT_BROKER || 'mqtt://broker.emqx.io:1883';

const LWT_TOPIC = `relay/${UPSTREAM}/rx/${NODE_ID}/lwt`;
const LWT_PAYLOAD = JSON.stringify({ nodeId: NODE_ID, status: 'OFFLINE', timestamp: new Date().toISOString() });

console.log(`\n🏪 [TrafoC] Connecting to ${BROKER}...`);

const connectOptions = {
  clientId: CLIENT_ID,
  clean: true,
  connectTimeout: 10000,
  reconnectPeriod: 3000,
  will: { topic: LWT_TOPIC, payload: LWT_PAYLOAD, qos: 1, retain: true },
};
if (process.env.MQTT_USERNAME) connectOptions.username = process.env.MQTT_USERNAME;
if (process.env.MQTT_PASSWORD) connectOptions.password = process.env.MQTT_PASSWORD;

const client = mqtt.connect(BROKER, connectOptions);

// ─── State ────────────────────────────────────────────────────────────────────
let upstreamStatus = 'NORMAL';
let ownStatus = 'NORMAL';

function generateSensorData() {
  const t = Date.now() / 1000;

  // Auto-recover jika node sedang NO_POWER dan upstream kembali NORMAL
  if (ownStatus === 'NO_POWER' && upstreamStatus === 'NORMAL') {
    ownStatus = 'NORMAL';
  }

  if (['FAULT', 'NO_POWER', 'OFFLINE', 'ISOLATED'].includes(upstreamStatus)) {
    ownStatus = 'NO_POWER';
    return { tegangan: 0, arus: 0, beban: 0, suhu: 30 + Math.random() * 2 };
  }
  if (['FAULT', 'NO_POWER'].includes(ownStatus)) {
    return { tegangan: 0, arus: 0, beban: 0, suhu: 38 + Math.random() * 2 };
  }
  if (ownStatus === 'ISOLATED') {
    return { tegangan: 220 + (Math.random() - 0.5) * 3, arus: 0, beban: 0, suhu: 40 + Math.random() * 2 };
  }

  // Residensial: Beban fluktuatif kecil
  const cycle = (t % 60) / 60;
  let beban = 35 + 20 * Math.sin(cycle * Math.PI) + Math.random() * 5;
  beban = Math.min(96, Math.max(20, beban));
  let tegangan = 220 + (Math.random() - 0.5) * 5;
  let arus = 160 + (beban / 100) * 120 + Math.random() * 15;
  let suhu = 42 + (beban / 100) * 15 + Math.random() * 3;

  ownStatus = beban > 85 ? 'WARNING' : 'NORMAL';

  return { tegangan: +tegangan.toFixed(1), arus: +arus.toFixed(1), beban: +beban.toFixed(1), suhu: +suhu.toFixed(1) };
}

function publishData() {
  const ts = new Date().toISOString();
  const base = { nodeId: NODE_ID, timestamp: ts };
  const data = generateSensorData();
  const daya = +(data.tegangan * data.arus / 1000).toFixed(2);

  const PUB_BASE = `relay/${UPSTREAM}/rx/${NODE_ID}`;
  client.publish(`${PUB_BASE}/tegangan`, JSON.stringify({ ...base, value: data.tegangan, unit: 'V' }), { qos: 0, retain: true });
  client.publish(`${PUB_BASE}/arus`, JSON.stringify({ ...base, value: data.arus, unit: 'A' }), { qos: 0, retain: true });
  client.publish(`${PUB_BASE}/beban`, JSON.stringify({ ...base, value: data.beban, unit: '%' }), { qos: 0, retain: true });
  client.publish(`${PUB_BASE}/suhu`, JSON.stringify({ ...base, value: data.suhu, unit: '°C' }), { qos: 0, retain: true });
  client.publish(`${PUB_BASE}/daya`, JSON.stringify({ ...base, value: daya, unit: 'kW' }), { qos: 0, retain: true });

  client.publish(
    `${PUB_BASE}/status`,
    JSON.stringify({ ...base, status: ownStatus, upstreamStatus, role: 'Distribusi Tepi Danau', area: 'Desa Maninjau', level: '20kV→220V' }),
    { qos: 1, retain: true }
  );

  if (ownStatus === 'FAULT' || data.beban > 88 || data.suhu > 80) {
    client.publish(
      `${PUB_BASE}/alarm`,
      JSON.stringify({
        ...base,
        level: ownStatus === 'FAULT' ? 'CRITICAL' : 'WARNING',
        message: ownStatus === 'FAULT'
          ? 'Trafo C FAULT — pemadaman di area Maninjau!'
          : `Trafo C (Maninjau): beban ${data.beban.toFixed(1)}% | suhu ${data.suhu.toFixed(1)}°C`,
        status: ownStatus,
      }),
      { qos: 2, retain: false }
    );
  }

  client.publish(LWT_TOPIC, JSON.stringify({ nodeId: NODE_ID, status: 'ONLINE', timestamp: ts }), { qos: 1, retain: true });

  const icon = { NORMAL: '🟢', WARNING: '🟡', FAULT: '🔴', ISOLATED: '🔒', NO_POWER: '⚫' }[ownStatus] || '❓';
  console.log(`${icon} [TrafoC] ${ownStatus} | upstream:${upstreamStatus} | ${data.tegangan}V | beban:${data.beban.toFixed(1)}%`);
}

// ─── Event Handlers ───────────────────────────────────────────────────────────
client.on('connect', () => {
  console.log(`✅ [TrafoC] Connected! Client ID: ${CLIENT_ID}`);

  client.subscribe(`gridwatch/${UPSTREAM}/status`, { qos: 1 }, (err) => {
    if (!err) console.log(`📥 [TrafoC] Subscribed to ${UPSTREAM}/status`);
  });
  client.subscribe(`gridwatch/${UPSTREAM}/lwt`, { qos: 1 }, () => { });
  client.subscribe(`gridwatch/kontrol/${NODE_ID}/cmd`, { qos: 2 }, (err) => {
    if (!err) console.log(`📥 [TrafoC] Subscribed to kontrol commands`);
  });
  client.subscribe(`relay/${NODE_ID}/rx/#`, { qos: 1 }, (err) => {
    if (!err) console.log(`📥 [TrafoC] Subscribed to relay from children`);
  });

  setInterval(publishData, 4000);
});

client.on('message', (topic, message) => {
  if (topic.startsWith(`relay/${NODE_ID}/rx/`)) {
    const forwardTopic = topic.replace(`relay/${NODE_ID}/rx/`, `relay/${UPSTREAM}/rx/`);
    client.publish(forwardTopic, message);
    return;
  }

  try {
    const payload = JSON.parse(message.toString());

    if (topic === `gridwatch/${UPSTREAM}/status`) {
      const prev = upstreamStatus;
      upstreamStatus = payload.status;
      if (prev !== upstreamStatus)
        console.log(`⚡ [TrafoC] Upstream berubah: ${prev} → ${upstreamStatus}`);
    }

    if (topic === `gridwatch/${UPSTREAM}/lwt` && payload.status === 'OFFLINE') {
      upstreamStatus = 'OFFLINE';
      console.log(`🔴 [TrafoC] Upstream OFFLINE via LWT!`);
    }

    if (topic === `gridwatch/kontrol/${NODE_ID}/cmd`) {
      const prev = ownStatus;
      if (payload.command === 'TRIP') ownStatus = 'ISOLATED';
      if (payload.command === 'RESET') ownStatus = ['FAULT', 'NO_POWER', 'OFFLINE', 'ISOLATED'].includes(upstreamStatus) ? 'NO_POWER' : 'NORMAL';
      if (payload.command === 'ISOLATE') ownStatus = 'ISOLATED';
      if (payload.command === 'FAULT') ownStatus = 'FAULT';
      console.log(`📨 [TrafoC] Command: ${payload.command} → ${prev} → ${ownStatus}`);

      client.publish(
        `gridwatch/kontrol/${NODE_ID}/ack`,
        JSON.stringify({ nodeId: NODE_ID, command: payload.command, status: ownStatus, timestamp: new Date().toISOString() }),
        { qos: 2 }
      );
    }
  } catch (e) { console.error('[TrafoC] Parse error:', e.message); }
});

client.on('error', (err) => console.error(`❌ [TrafoC] Error:`, err.message));
client.on('reconnect', () => console.log(`🔄 [TrafoC] Reconnecting...`));

// Intentionally no graceful LWT publish on SIGINT
// → broker akan auto-publish LWT saat koneksi terputus tiba-tiba
process.on('SIGINT', () => {
  console.log('\n🛑 [TrafoC] Crash simulation — LWT akan di-trigger oleh broker');
  client.end(true); // Force close tanpa DISCONNECT packet
  process.exit(0);
});
