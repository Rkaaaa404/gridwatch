/**
 * GridWatch — PusatKontrol Publisher (Command Center)
 * Role: Mengirim remote command ke node
 * QoS 2 mandatory — TRIP/RESET/FAULT/ISOLATE tidak boleh hilang/duplikat
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mqtt = require('mqtt');

const CLIENT_ID = 'publisher-kontrol-' + Math.random().toString(16).slice(2, 6);
const BROKER = process.env.MQTT_BROKER || 'mqtt://broker.emqx.io:1883';

console.log(`\n🎛️  [PusatKontrol] Connecting to ${BROKER}...`);

const connectOptions = {
  clientId: CLIENT_ID,
  clean: true,
  connectTimeout: 10000,
  reconnectPeriod: 3000,
};
if (process.env.MQTT_USERNAME) connectOptions.username = process.env.MQTT_USERNAME;
if (process.env.MQTT_PASSWORD) connectOptions.password = process.env.MQTT_PASSWORD;

const client = mqtt.connect(BROKER, connectOptions);

const VALID_NODES = ['gardu-induk', 'trafo-a', 'trafo-b', 'trafo-c'];
const VALID_CMDS = ['TRIP', 'RESET', 'ISOLATE', 'FAULT'];

// ─── Kirim Command ────────────────────────────────────────────────────────────
function sendCommand(nodeId, command, reason = 'Manual command') {
  const topic = `gridwatch/kontrol/${nodeId}/cmd`;
  const payload = JSON.stringify({
    from: 'pusat-kontrol',
    nodeId,
    command,
    reason,
    timestamp: new Date().toISOString(),
    operator: 'Operator',
  });

  client.publish(topic, payload, { qos: 2 }, (err) => {
    if (err) {
      console.error(`❌ [PusatKontrol] Gagal kirim ${command} → ${nodeId}:`, err.message);
    } else {
      console.log(`📤 [PusatKontrol] QoS-2 ✅  ${command.padEnd(8)} → ${nodeId}  (${reason})`);
    }
  });
}

// ─── Event Handlers ───────────────────────────────────────────────────────────
client.on('connect', () => {
  console.log(`✅ [PusatKontrol] Connected! Client ID: ${CLIENT_ID}`);

  // Monitor ACK dari semua node
  client.subscribe('gridwatch/kontrol/+/ack', { qos: 2 }, (err) => {
    if (!err) console.log(`📥 [PusatKontrol] Listening ACKs: gridwatch/kontrol/+/ack`);
  });

  // Monitor semua alarm
  client.subscribe('gridwatch/+/alarm', { qos: 2 }, (err) => {
    if (!err) console.log(`📥 [PusatKontrol] Monitoring alarms: gridwatch/+/alarm`);
  });

  // Expose sendCommand ke global untuk dipakai run-all.js jika perlu
  console.log(`
┌─────────────────────────────────────────────────────┐
│  🎛️  PusatKontrol — Manual Command Interface         │
│                                                     │
│  Format: <CMD> <NODE>                               │
│  Commands : TRIP | RESET | FAULT | ISOLATE          │
│  Nodes    : gardu-induk | trafo-a | trafo-b         │
│             trafo-c                                  │
│                                                     │
│  Contoh:                                            │
│    FAULT trafo-a                                    │
│    TRIP  trafo-b                                    │
│    RESET gardu-induk                                │
│    ISOLATE trafo-c                                  │
└─────────────────────────────────────────────────────┘
`);

  // Baca command dari stdin
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (input) => {
    const parts = input.trim().toUpperCase().split(/\s+/);
    if (parts.length < 2) {
      console.log(`❓ Format: <CMD> <NODE>  |  CMD: ${VALID_CMDS.join('|')}  |  NODE: ${VALID_NODES.join('|')}`);
      return;
    }

    const [cmd, nodeRaw, ...reasonParts] = parts;
    const nodeId = nodeRaw.toLowerCase().replace('_', '-');

    if (!VALID_CMDS.includes(cmd)) {
      console.log(`❓ Command tidak valid: ${cmd}  |  Valid: ${VALID_CMDS.join(', ')}`);
      return;
    }
    if (!VALID_NODES.includes(nodeId)) {
      console.log(`❓ Node tidak valid: ${nodeId}  |  Valid: ${VALID_NODES.join(', ')}`);
      return;
    }

    sendCommand(nodeId, cmd, reasonParts.join(' ') || 'Stdin manual');
  });
});

client.on('message', (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());

    if (topic.includes('/ack')) {
      console.log(`✅ [ACK] ${payload.nodeId}: ${payload.command} → status: ${payload.status}`);
    }
    if (topic.includes('/alarm')) {
      const lvl = payload.level === 'CRITICAL' ? '🔴 CRITICAL' : '🟡 WARNING';
      console.log(`🚨 [ALARM] [${lvl}] ${payload.nodeId}: ${payload.message}`);
    }
  } catch (e) { }
});

client.on('error', (err) => console.error(`❌ [PusatKontrol] Error:`, err.message));
client.on('reconnect', () => console.log(`🔄 [PusatKontrol] Reconnecting...`));

process.on('SIGINT', () => {
  console.log('\n🛑 [PusatKontrol] Shutting down...');
  client.end(); process.exit(0);
});

// Export untuk dipakai run-all jika diperlukan
module.exports = { sendCommand };
