// crawler entrypoint — starts only the background crawler process
// (timer + initial crawl cycle; no API/MCP/worker workloads)
import { bootstrap } from '../bootstrap.js';

bootstrap(['crawler']);
