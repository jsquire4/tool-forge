import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makeTestDb } from '../tests/helpers/db.js';
import { computeCoverage, loadApis } from './api-loader.js';
import { upsertToolRegistry } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_SPEC = JSON.parse(
  readFileSync(resolve(__dirname, '../tests/fixtures/openapi/sample.json'), 'utf-8')
);

// The sample.json has these path+method combos:
// GET  /api/portfolio/summary
// GET  /api/portfolio/holdings
// POST /api/portfolio/holdings
// GET  /api/trades
// POST /api/trades
// GET  /api/trades/{tradeId}
// DELETE /api/trades/{tradeId}
// GET  /api/market/prices
// Total = 8 endpoints

describe('computeCoverage', () => {
  let db;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('5 paths, 3 covered → { covered: 3, uncovered: 5, total: 8 }', () => {
    // Insert 3 promoted tools that match 3 specific endpoints
    upsertToolRegistry(db, {
      tool_name: 'get_portfolio_summary',
      lifecycle_state: 'promoted',
      spec_json: JSON.stringify({
        name: 'get_portfolio_summary',
        mcpRouting: { endpoint: '/api/portfolio/summary', method: 'GET' }
      })
    });
    upsertToolRegistry(db, {
      tool_name: 'get_holdings',
      lifecycle_state: 'promoted',
      spec_json: JSON.stringify({
        name: 'get_holdings',
        mcpRouting: { endpoint: '/api/portfolio/holdings', method: 'GET' }
      })
    });
    upsertToolRegistry(db, {
      tool_name: 'list_trades',
      lifecycle_state: 'promoted',
      spec_json: JSON.stringify({
        name: 'list_trades',
        mcpRouting: { endpoint: '/api/trades', method: 'GET' }
      })
    });

    const result = computeCoverage(SAMPLE_SPEC, db);
    expect(result.total).toBe(8);
    expect(result.covered.length).toBe(3);
    expect(result.uncovered.length).toBe(5);
  });

  it('covered + uncovered === total invariant always holds', () => {
    upsertToolRegistry(db, {
      tool_name: 'get_market_prices',
      lifecycle_state: 'promoted',
      spec_json: JSON.stringify({
        name: 'get_market_prices',
        mcpRouting: { endpoint: '/api/market/prices', method: 'GET' }
      })
    });

    const result = computeCoverage(SAMPLE_SPEC, db);
    expect(result.covered.length + result.uncovered.length).toBe(result.total);
  });

  it('empty spec → { covered: [], uncovered: [], total: 0 }', () => {
    const emptySpec = { openapi: '3.0.0', info: { title: 'Empty', version: '1.0.0' }, paths: {} };
    const result = computeCoverage(emptySpec, db);
    expect(result.total).toBe(0);
    expect(result.covered).toEqual([]);
    expect(result.uncovered).toEqual([]);
  });

  it('null/missing spec → { covered: [], uncovered: [], total: 0 }', () => {
    const result = computeCoverage(null, db);
    expect(result.total).toBe(0);
    expect(result.covered).toEqual([]);
    expect(result.uncovered).toEqual([]);
  });

  it('no promoted tools → all endpoints uncovered', () => {
    // Add a candidate tool — should not count as coverage
    upsertToolRegistry(db, {
      tool_name: 'candidate_tool',
      lifecycle_state: 'candidate',
      spec_json: JSON.stringify({
        name: 'candidate_tool',
        mcpRouting: { endpoint: '/api/portfolio/summary', method: 'GET' }
      })
    });

    const result = computeCoverage(SAMPLE_SPEC, db);
    expect(result.covered.length).toBe(0);
    expect(result.uncovered.length).toBe(result.total);
    expect(result.total).toBe(8);
  });

  it('multi-method path (GET + POST) → each method counted separately', () => {
    // Cover only GET /api/portfolio/holdings (not POST)
    upsertToolRegistry(db, {
      tool_name: 'get_holdings',
      lifecycle_state: 'promoted',
      spec_json: JSON.stringify({
        name: 'get_holdings',
        mcpRouting: { endpoint: '/api/portfolio/holdings', method: 'GET' }
      })
    });

    const result = computeCoverage(SAMPLE_SPEC, db);
    // GET /api/portfolio/holdings covered, POST /api/portfolio/holdings uncovered
    const coveredPaths = result.covered.map(e => `${e.method}:${e.path}`);
    const uncoveredPaths = result.uncovered.map(e => `${e.method}:${e.path}`);
    expect(coveredPaths).toContain('GET:/api/portfolio/holdings');
    expect(uncoveredPaths).toContain('POST:/api/portfolio/holdings');
  });

  it('malformed spec_json in promoted tool → that tool does not match any path', () => {
    upsertToolRegistry(db, {
      tool_name: 'broken_tool',
      lifecycle_state: 'promoted',
      spec_json: 'NOT VALID JSON {{{'
    });
    upsertToolRegistry(db, {
      tool_name: 'good_tool',
      lifecycle_state: 'promoted',
      spec_json: JSON.stringify({
        name: 'good_tool',
        mcpRouting: { endpoint: '/api/market/prices', method: 'GET' }
      })
    });

    const result = computeCoverage(SAMPLE_SPEC, db);
    // broken_tool should not match anything; good_tool should cover 1
    expect(result.covered.length).toBe(1);
    expect(result.covered[0].path).toBe('/api/market/prices');
    expect(result.covered[0].method).toBe('GET');
  });

  it('matching is case-insensitive for method', () => {
    upsertToolRegistry(db, {
      tool_name: 'post_holdings',
      lifecycle_state: 'promoted',
      spec_json: JSON.stringify({
        name: 'post_holdings',
        mcpRouting: { endpoint: '/api/portfolio/holdings', method: 'post' }
      })
    });

    const result = computeCoverage(SAMPLE_SPEC, db);
    const coveredPaths = result.covered.map(e => `${e.method}:${e.path}`);
    expect(coveredPaths).toContain('POST:/api/portfolio/holdings');
  });

  it('matching ignores leading slash differences', () => {
    // Tool endpoint stored without leading slash
    upsertToolRegistry(db, {
      tool_name: 'get_trades',
      lifecycle_state: 'promoted',
      spec_json: JSON.stringify({
        name: 'get_trades',
        mcpRouting: { endpoint: 'api/trades', method: 'GET' }
      })
    });

    const result = computeCoverage(SAMPLE_SPEC, db);
    const coveredPaths = result.covered.map(e => `${e.method}:${e.path}`);
    expect(coveredPaths).toContain('GET:/api/trades');
  });

  it('tool with no mcpRouting.endpoint does not match any path', () => {
    upsertToolRegistry(db, {
      tool_name: 'no_routing_tool',
      lifecycle_state: 'promoted',
      spec_json: JSON.stringify({
        name: 'no_routing_tool',
        description: 'A tool with no mcpRouting'
      })
    });

    const result = computeCoverage(SAMPLE_SPEC, db);
    expect(result.covered.length).toBe(0);
  });

  it('retired tools do not count as coverage', () => {
    upsertToolRegistry(db, {
      tool_name: 'retired_tool',
      lifecycle_state: 'retired',
      spec_json: JSON.stringify({
        name: 'retired_tool',
        mcpRouting: { endpoint: '/api/market/prices', method: 'GET' }
      })
    });

    const result = computeCoverage(SAMPLE_SPEC, db);
    expect(result.covered.length).toBe(0);
    expect(result.uncovered.length).toBe(result.total);
  });
});

// ── loadApis ────────────────────────────────────────────────────────────────

describe('loadApis', () => {
  it('empty config object → returns []', async () => {
    const endpoints = await loadApis({});
    expect(endpoints).toEqual([]);
  });

  it('null/undefined config → returns []', async () => {
    expect(await loadApis(null)).toEqual([]);
    expect(await loadApis(undefined)).toEqual([]);
  });

  it('discovery.type=openapi with file → returns endpoints from the spec', async () => {
    const config = {
      discovery: {
        type: 'openapi',
        file: 'tests/fixtures/openapi/sample.json'
      }
    };
    const endpoints = await loadApis(config);
    expect(endpoints.length).toBe(8);
    expect(endpoints.every((e) => e.path && e.method)).toBe(true);
    expect(endpoints.every((e) => e.source === 'openapi')).toBe(true);
  });

  it('manifestPath → returns endpoints from manifest', async () => {
    const config = {
      manifestPath: 'tests/fixtures/manifest/sample.json'
    };
    const endpoints = await loadApis(config);
    expect(endpoints.length).toBe(2);
    const paths = endpoints.map((e) => e.path);
    expect(paths).toContain('/api/orders');
    expect(endpoints.every((e) => e.source === 'manifest')).toBe(true);
  });

  it('manifest overrides openapi for same path+method', async () => {
    const config = {
      discovery: {
        type: 'openapi',
        file: 'tests/fixtures/openapi/sample.json'
      },
      manifestPath: 'tests/fixtures/manifest/sample.json'
    };
    const endpoints = await loadApis(config);
    // manifest adds 2 new paths; no overlap with sample.json, so total = 8 + 2
    expect(endpoints.length).toBe(10);
  });

  it('nonexistent file → returns []', async () => {
    const config = {
      discovery: {
        type: 'openapi',
        file: 'tests/fixtures/openapi/does-not-exist.json'
      }
    };
    const endpoints = await loadApis(config);
    expect(endpoints).toEqual([]);
  });
});
