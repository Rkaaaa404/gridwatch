/**
 * GridWatch — Dashboard HTTP Server
 * Serves the static dashboard HTML/CSS/JS files
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const path = require('path');

const app = express();
const PORT = parseInt(process.env.DASHBOARD_PORT || '3000');

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🌐 [Dashboard] Server running at http://localhost:${PORT}`);
  console.log(`   Open your browser and navigate to http://localhost:${PORT}\n`);
});
