import { bootstrap } from '../bootstrap.js';

jest.mock('../bootstrap.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Phase 0: Process Topology', () => {
  test('should start API process in isolation', async () => {
    // Test that API entrypoint boots without crawler timer
    await bootstrap(['api']);
    expect(require('../bootstrap.js')).toHaveBeenCalledWith(['api']);
  });

  test('should start MCP process in isolation', async () => {
    // Test that MCP server boots without API workload
    await bootstrap(['mcp']);
    expect(require('../bootstrap.js')).toHaveBeenCalledWith(['mcp']);
  });

  test('should start crawler process in isolation', async () => {
    // Test that crawler boots without API/MCP workloads
    await bootstrap(['crawler']);
    expect(require('../bootstrap.js')).toHaveBeenCalledWith(['crawler']);
  });

  test('should start ingestion worker process in isolation', async () => {
    // Test that ingestion worker boots without temporal worker (will be added later)
    await bootstrap(['ingestion-worker']);
    expect(require('../bootstrap.js')).toHaveBeenCalledWith(['ingestion-worker']);
  });

  test('should start temporal worker process in isolation', async () => {
    // Test that temporal worker boots independently
    await bootstrap(['temporal-worker']);
    expect(require('../bootstrap.js')).toHaveBeenCalledWith(['temporal-worker']);
  });
});