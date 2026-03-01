import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeTestDb } from '../../tests/helpers/db.js';
import { createAuth } from '../auth.js';
import { makePreferenceStore } from '../preference-store.js';
import { handleGetPreferences, handlePutPreferences } from './preferences.js';

function base64Url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeJwt(payload) {
  const header = base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  return `${header}.${body}.nosig`;
}

function makeReq(method, body, token) {
  const bodyStr = body ? JSON.stringify(body) : '';
  return {
    method,
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

function makeCtx(db, overrides = {}) {
  const config = {
    auth: { mode: 'trust', claimsPath: 'sub' },
    defaultModel: 'claude-sonnet-4-6',
    defaultHitlLevel: 'cautious',
    allowUserModelSelect: false,
    allowUserHitlConfig: false,
    ...overrides
  };
  return {
    auth: createAuth(config.auth),
    preferenceStore: makePreferenceStore(config, db),
    config,
    env: { ANTHROPIC_API_KEY: 'test-key' }
  };
}

describe('Preferences API', () => {
  let db;
  beforeEach(() => { db = makeTestDb(); });

  describe('GET', () => {
    it('returns prefs + effective + permissions', async () => {
      const token = makeJwt({ sub: 'user-1' });
      const res = makeRes();
      await handleGetPreferences(makeReq('GET', null, token), res, makeCtx(db));

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(res.body.preferences).toBeTruthy();
      expect(res.body.effective).toBeTruthy();
      expect(res.body.permissions).toBeTruthy();
      expect(res.body.permissions.canChangeModel).toBe(false);
    });

    it('returns 401 without auth', async () => {
      const res = makeRes();
      await handleGetPreferences(makeReq('GET', null, null), res, makeCtx(db));
      expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    });
  });

  describe('PUT', () => {
    it('updates when allowed', async () => {
      const token = makeJwt({ sub: 'user-1' });
      const ctx = makeCtx(db, { allowUserModelSelect: true, allowUserHitlConfig: true });

      const res = makeRes();
      await handlePutPreferences(
        makeReq('PUT', { model: 'gpt-4o', hitl_level: 'paranoid' }, token),
        res, ctx
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(res.body.ok).toBe(true);

      // Verify stored
      const getRes = makeRes();
      await handleGetPreferences(makeReq('GET', null, token), getRes, ctx);
      expect(getRes.body.preferences.model).toBe('gpt-4o');
    });

    it('returns 403 when model change disallowed', async () => {
      const token = makeJwt({ sub: 'user-1' });
      const res = makeRes();
      await handlePutPreferences(
        makeReq('PUT', { model: 'gpt-4o' }, token),
        res, makeCtx(db, { allowUserModelSelect: false })
      );
      expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    });

    it('returns 403 when hitl change disallowed', async () => {
      const token = makeJwt({ sub: 'user-1' });
      const res = makeRes();
      await handlePutPreferences(
        makeReq('PUT', { hitl_level: 'paranoid' }, token),
        res, makeCtx(db, { allowUserHitlConfig: false })
      );
      expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    });

    it('validates hitlLevel against allowed values', async () => {
      const token = makeJwt({ sub: 'user-1' });
      const res = makeRes();
      await handlePutPreferences(
        makeReq('PUT', { hitl_level: 'invalid' }, token),
        res, makeCtx(db, { allowUserHitlConfig: true })
      );
      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });
  });
});
