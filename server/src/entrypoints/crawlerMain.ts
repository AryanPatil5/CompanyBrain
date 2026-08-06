import express from 'express';
import dotenv from 'dotenv';
import { startCrawlerWorker } from '../services/crawler.js';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 5002;

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'Company Brain Crawler' });
});

const server = app.listen(PORT, () => {
  console.log(`[INFO] Company Brain Crawler running at http://localhost:${PORT}`);
});

startCrawlerWorker();

const shutdown = async () => {
  console.log('[INFO] Gracefully shutting down Crawler...');
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
