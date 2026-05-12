/**
 * GridWatch — GarduInduk Publisher
 * Role: Root node (sumber daya utama), pure Publisher
 * Status hanya berubah lewat command dari PusatKontrol / Dashboard
 * QoS: 0 sensor, 1 status, 2 alarm
 * LWT: auto-publish "OFFLINE" jika crash
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mqtt = require('mqtt');

const CLIENT_ID = 'publisher-gardu-induk-' + Math.random().toString(16).slice(2, 6);
const NODE_ID   = 'gardu-induk';
const BROKER    = process.env.MQTT_BROKER || 'mqtt://broker.emqx.io:1883';

const LWT_TOPIC   = `gridwatch/${NODE_ID}/lwt`;
const LWT_PAYLOAD = JSON.stringify({ nodeId: NODE_ID, status: 'OFFLINE', timestamp: new Date().toISOString() });

console.log(`\n⚡ [GarduInduk] Connecting to ${BROKER}...`);

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

// ─── State — hanya berubah via command ────────────────────────────────────────
let operationalStatus = 'NORMAL'; // NORMAL | WARNING | FAULT | ISOLATED | NO_POWER

// Sensor berfluktuasi realistis, tapi TIDAK ada forced fault
function generateSensorData() {
  const t = Date.now() / 1000;

  // Jika node dalam kondisi tidak normal, sensor nol
  if (['FAULT', 'NO_POWER'].includes(operationalStatus)) {
    return { tegangan: 0, arus: 0, beban: 0, suhu: 38 + Math.random() * 3 };
  }
  if (operationalStatus === 'ISOLATED') {
    return { tegangan: 20000 + (Math.random() - 0.5) * 100, arus: 0, beban: 0, suhu: 45 + Math.random() * 3 };
  }

  let tegangan = 20000 + (Math.random() - 0.5) * 300;
  let arus     = 270 + Math.sin(t / 30) * 40 + Math.random() * 20;
  let beban    = 55 + Math.sin(t / 25) * 12 + Math.random() * 6; // 37–73%
  let suhu     = 52 + (beban / 100) * 10 + Math.random() * 4;

  // WARNING hanya naik secara alami, tidak pernah fault sendiri
  operationalStatus = beban > 85 ? 'WARNING' : 'NORMAL';

  return { tegangan: +tegangan.toFixed(1), arus: +arus.toFixed(1), beban: +beban.toFixed(1), suhu: +suhu.toFixed(1) };
}

// ─── Publish ──────────────────────────────────────────────────────────────────
function publishSensor(data) {
  const ts   = new Date().toISOString();
  const base = { nodeId: NODE_ID, timestamp: ts };
  const daya = +(data.tegangan * data.arus / 1000).toFixed(2);

  // Menggunakan Topic Alias untuk sensor data frekuensi tinggi
  client.publish(`gridwatch/${NODE_ID}/tegangan`, JSON.stringify({ ...base, value: data.tegangan, unit: 'V' }),   { qos: 0, retain: true, properties: { topicAlias: 1 } });
  client.publish(`gridwatch/${NODE_ID}/arus`,     JSON.stringify({ ...base, value: data.arus,     unit: 'A' }),   { qos: 0, retain: true, properties: { topicAlias: 2 } });
  client.publish(`gridwatch/${NODE_ID}/beban`,    JSON.stringify({ ...base, value: data.beban,    unit: '%' }),   { qos: 0, retain: true, properties: { topicAlias: 3 } });
  client.publish(`gridwatch/${NODE_ID}/suhu`,     JSON.stringify({ ...base, value: data.suhu,     unit: '°C' }),  { qos: 0, retain: true, properties: { topicAlias: 4 } });
  client.publish(`gridwatch/${NODE_ID}/daya`,     JSON.stringify({ ...base, value: daya,           unit: 'kW' }), { qos: 0, retain: true, properties: { topicAlias: 5 } });

  client.publish(
    `gridwatch/${NODE_ID}/status`,
    JSON.stringify({ ...base, status: operationalStatus, role: 'Root Node / Gateway', area: 'Bukittinggi', level: '150kV→20kV' }),
    { qos: 1, retain: true }
  );

  if (['FAULT'].includes(operationalStatus) || data.beban > 88) {
    client.publish(
      `gridwatch/${NODE_ID}/alarm`,
      JSON.stringify({
        ...base,
        level: operationalStatus === 'FAULT' ? 'CRITICAL' : 'WARNING',
        message: operationalStatus === 'FAULT'
          ? 'Gardu Induk FAULT — circuit breaker utama trip!'
          : `Beban kritis Gardu Induk: ${data.beban.toFixed(1)}%`,
        status: operationalStatus,
      }),
      { qos: 2, retain: false, properties: { messageExpiryInterval: 3600 } }
    );
  }

  client.publish(LWT_TOPIC, JSON.stringify({ nodeId: NODE_ID, status: 'ONLINE', timestamp: ts }), { qos: 1, retain: true });

  const icon = { NORMAL: '🟢', WARNING: '🟡', FAULT: '🔴', ISOLATED: '🔒', NO_POWER: '⚫' }[operationalStatus] || '❓';
  console.log(`${icon} [GarduInduk] ${operationalStatus} | ${data.tegangan}V | beban ${data.beban.toFixed(1)}%`);
}

// ─── Event Handlers ───────────────────────────────────────────────────────────
client.on('connect', () => {
  console.log(`✅ [GarduInduk] Connected! Client ID: ${CLIENT_ID}`);

  // Subscribe ke kontrol command untuk node ini
  client.subscribe(`gridwatch/kontrol/${NODE_ID}/cmd`, { qos: 2 }, (err) => {
    if (!err) console.log(`📥 [GarduInduk] Subscribed to kontrol commands`);
  });
  client.subscribe(`relay/${NODE_ID}/rx/#`, { qos: 1 }, (err) => {
    if (!err) console.log(`📥 [GarduInduk] Subscribed to relay from children`);
  });

  setInterval(() => publishSensor(generateSensorData()), 2000);
});

client.on('message', (topic, message) => {
  if (topic.startsWith(`relay/${NODE_ID}/rx/`)) {
    const forwardTopic = topic.replace(`relay/${NODE_ID}/rx/`, `gridwatch/`);
    client.publish(forwardTopic, message);
    return;
  }

  try {
    const payload = JSON.parse(message.toString());
    if (topic === `gridwatch/kontrol/${NODE_ID}/cmd`) {
      const prev = operationalStatus;
      if (payload.command === 'TRIP')    operationalStatus = 'ISOLATED';
      if (payload.command === 'RESET')   operationalStatus = 'NORMAL';
      if (payload.command === 'ISOLATE') operationalStatus = 'ISOLATED';
      if (payload.command === 'FAULT')   operationalStatus = 'FAULT';
      console.log(`📨 [GarduInduk] Command: ${payload.command} → status: ${prev} → ${operationalStatus}`);

      client.publish(
        `gridwatch/kontrol/${NODE_ID}/ack`,
        JSON.stringify({ nodeId: NODE_ID, command: payload.command, status: operationalStatus, timestamp: new Date().toISOString() }),
        { qos: 2 }
      );
    }
  } catch (e) { console.error('[GarduInduk] Parse error:', e.message); }
});

client.on('error',     (err) => console.error(`❌ [GarduInduk] Error:`, err.message));
client.on('reconnect', ()    => console.log(`🔄 [GarduInduk] Reconnecting...`));
client.on('offline',   ()    => console.log(`📴 [GarduInduk] Offline`));

process.on('SIGINT', () => {
  console.log('\n🛑 [GarduInduk] Shutting down...');
  client.publish(LWT_TOPIC, JSON.stringify({ nodeId: NODE_ID, status: 'OFFLINE', timestamp: new Date().toISOString() }), { qos: 1, retain: true }, () => {
    client.end(); process.exit(0);
  });
});
