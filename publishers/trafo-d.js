/**
 * GridWatch — TrafoD Publisher + Subscriber
 * Role: End Node Pelosok (Palembayan, Agam)
 * Subscribe ke: gridwatch/trafo-b/status
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mqtt = require('mqtt');

const CLIENT_ID = 'publisher-trafo-d-' + Math.random().toString(16).slice(2, 6);
const NODE_ID = 'trafo-d';
const UPSTREAM = 'trafo-b';
const BROKER = process.env.MQTT_BROKER || 'mqtt://broker.emqx.io:1883';

const LWT_TOPIC = `relay/${UPSTREAM}/rx/${NODE_ID}/lwt`;
const LWT_PAYLOAD = JSON.stringify({ nodeId: NODE_ID, status: 'OFFLINE', timestamp: new Date().toISOString() });

console.log(`\n🏭 [TrafoD] Connecting to ${BROKER}...`);

const connectOptions = {
  clientId: CLIENT_ID,
  clean: true,
  connectTimeout: 10000,
  reconnectPeriod: 3000,
  protocolVersion: 5,
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
    return { tegangan: 0, arus: 0, beban: 0, suhu: 36 + Math.random() * 2, powerFactor: 0 };
  }
  if (['FAULT', 'NO_POWER'].includes(ownStatus)) {
    return { tegangan: 0, arus: 0, beban: 0, suhu: 42 + Math.random() * 3, powerFactor: 0 };
  }
  if (ownStatus === 'ISOLATED') {
    return { tegangan: 380 + (Math.random() - 0.5) * 5, arus: 0, beban: 0, suhu: 44 + Math.random() * 2, powerFactor: 0 };
  }

  // Residensial: Beban lebih stabil, PF lebih bagus
  let beban = 40 + Math.sin(t / 25) * 15 + Math.random() * 8; // 25–63%
  let tegangan = 380 + (Math.random() - 0.5) * 10;
  let arus = 220 + (beban / 100) * 150 + Math.random() * 20;
  let suhu = 48 + (beban / 100) * 20 + Math.random() * 4;
  let powerFactor = 0.92 + Math.random() * 0.05;

  ownStatus = beban > 85 ? 'WARNING' : 'NORMAL';

  return {
    tegangan: +tegangan.toFixed(1),
    arus: +arus.toFixed(1),
    beban: +beban.toFixed(1),
    suhu: +suhu.toFixed(1),
    powerFactor: +powerFactor.toFixed(3),
  };
}

function publishData() {
  const ts = new Date().toISOString();
  const base = { nodeId: NODE_ID, timestamp: ts };
  const data = generateSensorData();
  const daya = +(data.tegangan * data.arus * (data.powerFactor || 1) * Math.sqrt(3) / 1000).toFixed(2);

  const PUB_BASE = `relay/${UPSTREAM}/rx/${NODE_ID}`;
  client.publish(`${PUB_BASE}/tegangan`, JSON.stringify({ ...base, value: data.tegangan, unit: 'V', phase: '3-phase' }), { qos: 0, retain: true, properties: { topicAlias: 1 } });
  client.publish(`${PUB_BASE}/arus`, JSON.stringify({ ...base, value: data.arus, unit: 'A' }), { qos: 0, retain: true, properties: { topicAlias: 2 } });
  client.publish(`${PUB_BASE}/beban`, JSON.stringify({ ...base, value: data.beban, unit: '%' }), { qos: 0, retain: true, properties: { topicAlias: 3 } });
  client.publish(`${PUB_BASE}/suhu`, JSON.stringify({ ...base, value: data.suhu, unit: '°C' }), { qos: 0, retain: true, properties: { topicAlias: 4 } });
  client.publish(`${PUB_BASE}/daya`, JSON.stringify({ ...base, value: daya, unit: 'kW', powerFactor: data.powerFactor }), { qos: 0, retain: true, properties: { topicAlias: 5 } });

  client.publish(
    `${PUB_BASE}/status`,
    JSON.stringify({ ...base, status: ownStatus, upstreamStatus, role: 'End Node Pelosok (LoRa Relay)', area: 'Pelosok Palembayan', level: '20kV→380V', phase: '3-phase' }),
    { qos: 1, retain: true }
  );

  if (ownStatus === 'FAULT' || data.beban > 88 || data.suhu > 82) {
    client.publish(
      `${PUB_BASE}/alarm`,
      JSON.stringify({
        ...base,
        level: ownStatus === 'FAULT' ? 'CRITICAL' : 'WARNING',
        message: ownStatus === 'FAULT'
          ? 'Trafo B FAULT — jaringan terputus di Palembayan!'
          : data.suhu > 82
            ? `Suhu kritis Trafo B: ${data.suhu.toFixed(1)}°C`
            : `Beban residensial tinggi: ${data.beban.toFixed(1)}% | PF: ${data.powerFactor}`,
        status: ownStatus,
      }),
      { qos: 2, retain: false, properties: { messageExpiryInterval: 3600 } }
    );
  }

  client.publish(LWT_TOPIC, JSON.stringify({ nodeId: NODE_ID, status: 'ONLINE', timestamp: ts }), { qos: 1, retain: true });

  const icon = { NORMAL: '🟢', WARNING: '🟡', FAULT: '🔴', ISOLATED: '🔒', NO_POWER: '⚫' }[ownStatus] || '❓';
  console.log(`${icon} [TrafoD] ${ownStatus} | upstream:${upstreamStatus} | beban:${data.beban.toFixed(1)}% | PF:${data.powerFactor}`);
}

// ─── Event Handlers ───────────────────────────────────────────────────────────
client.on('connect', () => {
  console.log(`✅ [TrafoD] Connected! Client ID: ${CLIENT_ID}`);

  client.subscribe(`gridwatch/${UPSTREAM}/status`, { qos: 1 }, (err) => {
    if (!err) console.log(`📥 [TrafoD] Subscribed to ${UPSTREAM}/status`);
  });
  client.subscribe(`gridwatch/${UPSTREAM}/lwt`, { qos: 1 }, () => { });
  client.subscribe(`gridwatch/kontrol/${NODE_ID}/cmd`, { qos: 2 }, (err) => {
    if (!err) console.log(`📥 [TrafoD] Subscribed to kontrol commands`);
  });

  setInterval(publishData, 2000);
});

client.on('message', (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());

    if (topic === `gridwatch/${UPSTREAM}/status`) {
      const prev = upstreamStatus;
      upstreamStatus = payload.status;
      if (prev !== upstreamStatus)
        console.log(`⚡ [TrafoD] Upstream berubah: ${prev} → ${upstreamStatus}`);
    }

    if (topic === `gridwatch/${UPSTREAM}/lwt` && payload.status === 'OFFLINE') {
      upstreamStatus = 'OFFLINE';
      console.log(`🔴 [TrafoD] Upstream OFFLINE via LWT!`);
    }

    if (topic === `gridwatch/kontrol/${NODE_ID}/cmd`) {
      const prev = ownStatus;
      if (payload.command === 'TRIP') ownStatus = 'ISOLATED';
      if (payload.command === 'RESET') ownStatus = ['FAULT', 'NO_POWER', 'OFFLINE', 'ISOLATED'].includes(upstreamStatus) ? 'NO_POWER' : 'NORMAL';
      if (payload.command === 'ISOLATE') ownStatus = 'ISOLATED';
      if (payload.command === 'FAULT') ownStatus = 'FAULT';
      console.log(`📨 [TrafoD] Command: ${payload.command} → ${prev} → ${ownStatus}`);

      client.publish(
        `gridwatch/kontrol/${NODE_ID}/ack`,
        JSON.stringify({ nodeId: NODE_ID, command: payload.command, status: ownStatus, timestamp: new Date().toISOString() }),
        { qos: 2 }
      );
    }
  } catch (e) { console.error('[TrafoD] Parse error:', e.message); }
});

client.on('error', (err) => console.error(`❌ [TrafoD] Error:`, err.message));
client.on('reconnect', () => console.log(`🔄 [TrafoD] Reconnecting...`));

process.on('SIGINT', () => {
  console.log('\n🛑 [TrafoD] Shutting down...');
  client.publish(LWT_TOPIC, JSON.stringify({ nodeId: NODE_ID, status: 'OFFLINE', timestamp: new Date().toISOString() }), { qos: 1, retain: true }, () => {
    client.end(); process.exit(0);
  });
});
