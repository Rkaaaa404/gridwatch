/**
 * GridWatch — DashboardSubscriber (WebSocket Bridge)
 * Role: MQTT → WebSocket bridge untuk frontend dashboard
 * Subscribe: gridwatch/# (semua data semua node)
 * Broadcast ke semua browser client via WebSocket server
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mqtt = require('mqtt');
const WebSocket = require('ws');

const CLIENT_ID = 'subscriber-dashboard-' + Math.random().toString(16).slice(2, 6);
const BROKER = process.env.MQTT_BROKER || 'mqtt://broker.emqx.io:1883';
const WS_PORT = parseInt(process.env.WS_PORT || '8080');

console.log(`\n📡 [DashboardSub] Starting WebSocket bridge on port ${WS_PORT}...`);

// ─── WebSocket Server ─────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ port: WS_PORT });
const wsClients = new Set();

wss.on('connection', (ws, req) => {
  wsClients.add(ws);
  console.log(`🖥️ [DashboardSub] Dashboard connected (${wsClients.size} clients)`);

  // Kirim state cache ke client baru agar langsung ter-update
  if (Object.keys(stateCache).length > 0) {
    ws.send(JSON.stringify({ type: 'STATE_SNAPSHOT', data: stateCache }));
  }

  // Terima command dari browser dashboard → forward ke MQTT
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'SEND_COMMAND' && msg.nodeId && msg.command) {
        const cmdTopic = `gridwatch/kontrol/${msg.nodeId}/cmd`;
        const cmdPayload = JSON.stringify({
          from: 'dashboard-ui',
          nodeId: msg.nodeId,
          command: msg.command,
          reason: 'Command dari Dashboard UI',
          timestamp: msg.timestamp || new Date().toISOString(),
          operator: 'Dashboard',
        });
        // QoS 2 — exactly-once
        client.publish(cmdTopic, cmdPayload, { qos: 2 }, (err) => {
          if (err) {
            console.error(`❌ [DashboardSub] Failed to forward command:`, err.message);
          } else {
            console.log(`📤 [DashboardSub] Forwarded ${msg.command} → ${msg.nodeId} (QoS 2)`);
          }
        });
      }
    } catch (e) { /* ignore */ }
  });

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`🔌 [DashboardSub] Dashboard disconnected (${wsClients.size} clients)`);
  });

  ws.on('error', (err) => {
    wsClients.delete(ws);
  });
});

// State cache — simpan data terkini setiap node
const stateCache = {};

// Broadcast ke semua WebSocket client
function broadcast(data) {
  const msg = JSON.stringify(data);
  wsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

// ─── MQTT Client ──────────────────────────────────────────────────────────────
const connectOptions = {
  clientId: CLIENT_ID,
  clean: true,
  connectTimeout: 10000,
  reconnectPeriod: 3000,
};
if (process.env.MQTT_USERNAME) connectOptions.username = process.env.MQTT_USERNAME;
if (process.env.MQTT_PASSWORD) connectOptions.password = process.env.MQTT_PASSWORD;

const client = mqtt.connect(BROKER, connectOptions);

client.on('connect', () => {
  console.log(`✅ [DashboardSub] MQTT Connected! Client ID: ${CLIENT_ID}`);

  // Subscribe ke SEMUA topic dengan wildcard multilevel #
  // Ini adalah demonstrasi wildcard #
  client.subscribe('gridwatch/#', { qos: 1 }, (err) => {
    if (!err) console.log(`📥 [DashboardSub] Subscribed to gridwatch/# (semua data semua node)`);
  });

  console.log(`🌐 [DashboardSub] WebSocket server ready at ws://localhost:${WS_PORT}`);
  console.log(`📊 [DashboardSub] Waiting for dashboard connections...\n`);
});

client.on('message', (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    const parts = topic.split('/');

    // Parse topic structure: gridwatch/{nodeId}/{sensor} atau gridwatch/kontrol/{nodeId}/{action}
    let nodeId, dataType;
    if (parts[1] === 'kontrol') {
      nodeId = parts[2];
      dataType = parts[3]; // cmd | ack
    } else {
      nodeId = parts[1];
      dataType = parts[2]; // tegangan | arus | status | dll
    }

    // Update state cache
    if (!stateCache[nodeId]) stateCache[nodeId] = {};
    if (!stateCache[nodeId][dataType]) stateCache[nodeId][dataType] = {};
    stateCache[nodeId][dataType] = payload;

    // Broadcast ke semua dashboard
    const wsMessage = {
      type: 'MQTT_MESSAGE',
      topic,
      nodeId,
      dataType,
      payload,
      receivedAt: new Date().toISOString(),
    };

    broadcast(wsMessage);

    // Log data penting saja
    if (['status', 'alarm', 'lwt'].includes(dataType)) {
      const icon = payload.status === 'NORMAL' ? '🟢' : payload.status === 'WARNING' ? '🟡' : payload.status === 'FAULT' ? '🔴' : payload.status === 'OFFLINE' ? '⚫' : '📡';
      if (dataType === 'alarm') {
        console.log(`🚨 [DashboardSub] ALARM ${nodeId}: ${payload.message}`);
      } else {
        console.log(`${icon} [DashboardSub] ${nodeId}/${dataType}: ${JSON.stringify(payload.status || payload)}`);
      }
    }

  } catch (e) {
    // Non-JSON message — ignore
  }
});

// Periodic ping ke semua WS clients
setInterval(() => {
  broadcast({ type: 'PING', timestamp: new Date().toISOString(), connectedClients: wsClients.size });
}, 10000);

client.on('error', (err) => console.error(`❌ [DashboardSub] MQTT Error:`, err.message));
client.on('reconnect', () => console.log(`🔄 [DashboardSub] MQTT Reconnecting...`));

process.on('SIGINT', () => {
  console.log('\n🛑 [DashboardSub] Shutting down...');
  wss.close();
  client.end();
  process.exit(0);
});
