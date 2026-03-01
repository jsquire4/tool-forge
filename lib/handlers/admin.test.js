import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock is hoisted by Vitest before imports, so this intercepts admin.js's
// `import { readFileSync, writeFileSync, renameSync } from 'fs'` binding.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue('{}'),
  };
});

import * as fsMocked from 'fs';
import { handleAdminConfig, _resetOverlay } from './admin.js';

function makeReq(method, path, body, token) {
  const bodyStr = body ? JSON.stringify(body) : '';
  return {
    method,
    url: path,
    headers: { authorization: token ? `Bearer ${token}` : undefined },
    on(event, handler) {
      if (event === 'data' && bodyStr) handler(bodyStr);
      if (event === 'end') handler();
    }
  };
}

function makeRes() {
  let responseBody;
  return {
    writeHead: vi.fn(),
    end: vi.fn((payload) => { responseBody = payload ? JSON.parse(payload) : null; }),
    get body() { return responseBody; }
  };
}

function makeCtx(adminKey = 'admin-secret') {
  return {
    config: {
      adminKey,
      defaultModel: 'claude-sonnet-4-6',
      defaultHitlLevel: 'cautious',
      allowUserModelSelect: false,
      allowUserHitlConfig: false,
      conversation: { window: 25 }
    }
  };
}

describe('Admin API', () => {
  beforeEach(() => { _resetOverlay(); });

  it('valid admin key: updates section', async () => {
    const res = makeRes();
    await handleAdminConfig(
      makeReq('PUT', '/forge-admin/config/model', { defaultModel: 'gpt-4o' }, 'admin-secret'),
      res, makeCtx()
    );
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(res.body.ok).toBe(true);
  });

  it('wrong key: 403', async () => {
    const res = makeRes();
    await handleAdminConfig(
      makeReq('PUT', '/forge-admin/config/model', {}, 'wrong-key'),
      res, makeCtx()
    );
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
  });

  it('no adminKey configured: 503', async () => {
    const res = makeRes();
    await handleAdminConfig(
      makeReq('PUT', '/forge-admin/config/model', {}, 'anything'),
      res, makeCtx(null)
    );
    expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
  });

  it('invalid section: 400', async () => {
    const res = makeRes();
    await handleAdminConfig(
      makeReq('PUT', '/forge-admin/config/invalid', {}, 'admin-secret'),
      res, makeCtx()
    );
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  });

  it('GET returns merged config', async () => {
    const ctx = makeCtx();
    const res = makeRes();
    await handleAdminConfig(
      makeReq('GET', '/forge-admin/config', null, 'admin-secret'),
      res, ctx
    );
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(res.body.defaultModel).toBe('claude-sonnet-4-6');
  });

  it('PUT model section updates config in ctx', async () => {
    const ctx = makeCtx();

    // PUT to update
    const putRes = makeRes();
    await handleAdminConfig(
      makeReq('PUT', '/forge-admin/config/model', { defaultModel: 'gpt-4o-mini' }, 'admin-secret'),
      putRes, ctx
    );
    expect(putRes.body.ok).toBe(true);

    // GET to verify
    const getRes = makeRes();
    await handleAdminConfig(
      makeReq('GET', '/forge-admin/config', null, 'admin-secret'),
      getRes, ctx
    );
    expect(getRes.body.defaultModel).toBe('gpt-4o-mini');
  });

  describe('overlay persistence', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      // Ensure readFileSync returns a valid JSON string for each test
      fsMocked.readFileSync.mockReturnValue('{}');
    });

    it('calls writeFileSync and renameSync when configPath is provided', async () => {
      const ctx = {
        ...makeCtx(),
        configPath: '/fake/forge.config.json'
      };

      const res = makeRes();
      await handleAdminConfig(
        makeReq('PUT', '/forge-admin/config/model', { defaultModel: 'gpt-4o' }, 'admin-secret'),
        res, ctx
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(res.body.ok).toBe(true);

      // Atomic write: first writes to .tmp file, then renames over configPath
      expect(fsMocked.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/\.tmp$/),
        expect.stringContaining('"defaultModel"'),
        'utf8'
      );
      expect(fsMocked.renameSync).toHaveBeenCalledWith(
        expect.stringMatching(/\.tmp$/),
        '/fake/forge.config.json'
      );
    });

    it('continues without error when configPath is not provided', async () => {
      const ctx = makeCtx(); // no configPath
      const res = makeRes();
      await handleAdminConfig(
        makeReq('PUT', '/forge-admin/config/hitl', { defaultHitlLevel: 'paranoid' }, 'admin-secret'),
        res, ctx
      );
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      // No file I/O should occur when configPath is absent
      expect(fsMocked.writeFileSync).not.toHaveBeenCalled();
      expect(fsMocked.renameSync).not.toHaveBeenCalled();
    });
  });
});
