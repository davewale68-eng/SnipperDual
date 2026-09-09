/**
 * SNIPER_V4 PRO v6.2 — Main Server Entry Point.
 */
const express = require('express');
const path = require('path');
const apiRoutes = require('./src/routes/api');
const { store } = require('./src/core/store');
const { loadSnapshot, saveSnapshot } = require('./src/services/persistence');
const { runSupremeCouncil } = require('./src/supreme/council');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get(['/health', '/api/health'], (req, res) => {
  res.json({
    status: 'ok',
    version: '6.2.0',
    system: 'SNIPER_V4 PRO — Autonomous Parliamentary Intelligence Platform with Meta-Intelligence',
    uptimeSeconds: Math.floor((Date.now() - store.startTime) / 1000)
  });
});

app.use('/api', apiRoutes);

loadSnapshot(store);
runSupremeCouncil();

setInterval(() => {
  saveSnapshot(store);
}, 30000);

app.listen(PORT, () => {
  console.log(`SNIPER_V4 PRO v6.2.0 running on port ${PORT}`);
});
