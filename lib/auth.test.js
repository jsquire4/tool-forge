import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { createAuth, authenticateAdmin } from './auth.js';

// Helper to create a minimal JWT (HS256)
function makeJwt(payload, secret = 'test-secret', alg = 'HS256') {
  const header = base64Url(JSON.stringify({ alg, typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  const sigInput = `${header}.${body}`;
  const sig = base64Url(
    createHmac('sha256', secret).update(sigInput).digest()
  );
  return `${header}.${body}.${sig}`;
}

// Unsigned JWT (for trust mode)
function makeUnsignedJwt(payload) {
  const header = base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  return `${header}.${body}.nosig`;
}

function base64Url(input) {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeReq(token) {
  return { headers: { authorization: token ? `Bearer ${token}` : undefined } };
}

describe('auth', () => {
  describe('trust mode', () => {
    const auth = createAuth({ mode: 'trust', claimsPath: 'sub' });

    it('valid JWT extracts userId', () => {
      const token = makeUnsignedJwt({ sub: 'user-42', name: 'Alice' });
      const result = auth.authenticate(makeReq(token));
      expect(result.authenticated).toBe(true);
      expect(result.userId).toBe('user-42');
      expect(result.claims.name).toBe('Alice');
    });

    it('malformed token returns authenticated: false', () => {
      const result = auth.authenticate(makeReq('not.a.jwt.at.all'));
      expect(result.authenticated).toBe(false);
    });

    it('missing Authorization header returns authenticated: false', () => {
      const result = auth.authenticate({ headers: {} });
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain('Missing');
    });

    it('empty token returns authenticated: false', () => {
      const result = auth.authenticate(makeReq(''));
      expect(result.authenticated).toBe(false);
    });
  });

  describe('verify mode (HS256)', () => {
    const secret = 'my-secret-key';
    const auth = createAuth({ mode: 'verify', signingKey: secret, claimsPath: 'sub' });

    it('valid signature passes', () => {
      const token = makeJwt({ sub: 'user-1' }, secret);
      const result = auth.authenticate(makeReq(token));
      expect(result.authenticated).toBe(true);
      expect(result.userId).toBe('user-1');
    });

    it('tampered payload fails', () => {
      const token = makeJwt({ sub: 'user-1' }, secret);
      // Tamper: change the payload
      const parts = token.split('.');
      parts[1] = base64Url(JSON.stringify({ sub: 'user-hacker' }));
      const tampered = parts.join('.');
      const result = auth.authenticate(makeReq(tampered));
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain('Invalid signature');
    });

    it('wrong secret fails', () => {
      const token = makeJwt({ sub: 'user-1' }, 'wrong-secret');
      const result = auth.authenticate(makeReq(token));
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain('Invalid signature');
    });
  });

  describe('custom claimsPath', () => {
    const auth = createAuth({ mode: 'trust', claimsPath: 'user.id' });

    it('extracts nested claim', () => {
      const token = makeUnsignedJwt({ user: { id: 'nested-123' } });
      const result = auth.authenticate(makeReq(token));
      expect(result.authenticated).toBe(true);
      expect(result.userId).toBe('nested-123');
    });

    it('returns error when claim path not found', () => {
      const token = makeUnsignedJwt({ sub: 'user-1' });
      const result = auth.authenticate(makeReq(token));
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain('user.id');
    });
  });

  describe('query param token fallback', () => {
    const auth = createAuth({ mode: 'trust', claimsPath: 'sub' });

    it('authenticates via ?token= query param', () => {
      const token = makeUnsignedJwt({ sub: 'user-qp' });
      const result = auth.authenticate({ headers: {}, url: `/agent-api/chat?token=${token}` });
      expect(result.authenticated).toBe(true);
      expect(result.userId).toBe('user-qp');
    });

    it('Authorization header takes priority over query param', () => {
      const headerToken = makeUnsignedJwt({ sub: 'header-user' });
      const queryToken = makeUnsignedJwt({ sub: 'query-user' });
      const result = auth.authenticate({
        headers: { authorization: `Bearer ${headerToken}` },
        url: `/agent-api/chat?token=${queryToken}`
      });
      expect(result.authenticated).toBe(true);
      expect(result.userId).toBe('header-user');
    });

    it('neither header nor query param returns unauthenticated', () => {
      const result = auth.authenticate({ headers: {}, url: '/agent-api/chat' });
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain('Missing token');
    });

    it('empty ?token= value returns unauthenticated', () => {
      const result = auth.authenticate({ headers: {}, url: '/agent-api/chat?token=' });
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain('Missing token');
    });

    it('malformed URL falls through to missing token', () => {
      const result = auth.authenticate({ headers: {}, url: ':::bad' });
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain('Missing token');
    });
  });

  describe('authenticateAdmin', () => {
    it('correct key authenticates', () => {
      const result = authenticateAdmin(makeReq('admin-key-123'), 'admin-key-123');
      expect(result.authenticated).toBe(true);
    });

    it('wrong key fails', () => {
      const result = authenticateAdmin(makeReq('wrong'), 'admin-key-123');
      expect(result.authenticated).toBe(false);
    });

    it('missing header fails', () => {
      const result = authenticateAdmin({ headers: {} }, 'admin-key-123');
      expect(result.authenticated).toBe(false);
    });

    it('no adminKey configured fails', () => {
      const result = authenticateAdmin(makeReq('anything'), null);
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain('No admin key');
    });
  });
});
