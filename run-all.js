/**
 * GridWatch — Run All Services
 * Spawns all publishers, subscribers, and dashboard server
 * Use: node run-all.js
 */

const { spawn } = require('child_process');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const BASE = __dirname;

const services = [
  { name: 'DashboardSub', script: 'subscribers/dashboard-subscriber.js', color: '\x1b[36m' },
  { name: 'AlertEngine',  script: 'subscribers/alert-engine.js',         color: '\x1b[35m' },
  { name: 'Dashboard',    script: 'dashboard/server.js',                  color: '\x1b[34m' },
  { name: 'GarduInduk',   script: 'publishers/gardu-induk.js',           color: '\x1b[33m' },
  { name: 'TrafoA',       script: 'publishers/trafo-a.js',               color: '\x1b[32m' },
  { name: 'TrafoB',       script: 'publishers/trafo-b.js',               color: '\x1b[96m' },
  { name: 'TrafoC',       script: 'publishers/trafo-c.js',               color: '\x1b[93m' },
  { name: 'TrafoD',       script: 'publishers/trafo-d.js',               color: '\x1b[95m' },
  { name: 'PusatKontrol', script: 'publishers/pusat-kontrol.js',         color: '\x1b[91m' },
];

const RESET = '\x1b[0m';
const processes = [];

console.log('\n⚡ GridWatch — Starting all services...\n');

// Stagger startup: subscribers/server first, then publishers
const STAGGER_MS = 1500;

services.forEach((svc, i) => {
  setTimeout(() => {
    const child = spawn('node', [path.join(BASE, svc.script)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    processes.push({ name: svc.name, process: child });

    child.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      lines.forEach(line => {
        console.log(`${svc.color}[${svc.name}]${RESET} ${line}`);
      });
    });

    child.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      lines.forEach(line => {
        console.log(`${svc.color}[${svc.name}]${RESET} \x1b[31m${line}${RESET}`);
      });
    });

    child.on('exit', (code) => {
      console.log(`\x1b[31m[${svc.name}] Exited with code ${code}${RESET}`);
    });

    if (i === 2) {
      // After dashboard server starts, show URL
      setTimeout(() => {
        console.log('\n\x1b[32m' + '═'.repeat(60) + RESET);
        console.log('\x1b[32m  🌐 Dashboard: http://localhost:3000\x1b[0m');
        console.log('\x1b[32m  📡 WebSocket: ws://localhost:8080\x1b[0m');
        console.log('\x1b[32m  🔗 MQTT Broker: ' + (process.env.MQTT_BROKER || 'mqtt://broker.emqx.io:1883') + '\x1b[0m');
        console.log('\x1b[32m' + '═'.repeat(60) + RESET + '\n');
      }, 1000);
    }
  }, i * STAGGER_MS);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\x1b[31m🛑 Shutting down all services...\x1b[0m');
  processes.forEach(({ name, process: p }) => {
    console.log(`   Stopping ${name}...`);
    p.kill('SIGINT');
  });
  setTimeout(() => process.exit(0), 2000);
});

console.log(`Starting ${services.length} services with ${STAGGER_MS}ms stagger...`);
console.log('Press Ctrl+C to stop all.\n');
