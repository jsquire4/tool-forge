/**
 * Auth module — configurable JWT authentication for the forge sidecar.
 *
 * Two modes:
 *   trust  — decode JWT payload without verifying signature (fast, for local dev / behind reverse proxy)
 *   verify — verify HMAC-SHA256 (HS256) or RSA-SHA256 (RS256) signature via Node.js built-in crypto
 *
 * No external JWT library required.
 */

import { createHmac, createVerify, timingSafeEqual } from 'crypto';

/**
 * @typedef {{ authenticated: boolean, userId: string|null, claims: object|null, error: string|null }} AuthResult
 */

/**
 * Create an authenticator from config.
 * @param {{ mode: 'verify'|'trust', signingKey?: string, claimsPath?: string }} authConfig
 * @returns {{ authenticate(req): AuthResult }}
 */
export function createAuth(authConfig = {}) {
  const mode = authConfig.mode ?? 'trust';
  const signingKey = authConfig.signingKey ?? null;
  const claimsPath = authConfig.claimsPath ?? 'sub';

  return {
    authenticate(req) {
      const authHeader = req.headers?.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { authenticated: false, userId: null, claims: null, error: 'Missing or invalid Authorization header' };
      }

      const token = authHeader.slice(7);
      if (!token) {
        return { authenticated: false, userId: null, claims: null, error: 'Empty token' };
      }

      const parts = token.split('.');
      if (parts.length !== 3) {
        return { authenticated: false, userId: null, claims: null, error: 'Malformed JWT' };
      }

      // Verify signature if in verify mode
      if (mode === 'verify') {
        if (!signingKey) {
          return { authenticated: false, userId: null, claims: null, error: 'No signing key configured' };
        }

        let header;
        try {
          header = JSON.parse(base64UrlDecode(parts[0]));
        } catch {
          return { authenticated: false, userId: null, claims: null, error: 'Invalid JWT header' };
        }

        const sigInput = `${parts[0]}.${parts[1]}`;
        const signature = parts[2];
        const alg = header.alg ?? 'HS256';

        if (alg === 'HS256') {
          const expected = base64UrlEncode(
            createHmac('sha256', signingKey).update(sigInput).digest()
          );
          const expectedBuf = Buffer.from(expected);
          const signatureBuf = Buffer.from(signature);
          if (expectedBuf.length !== signatureBuf.length || !timingSafeEqual(expectedBuf, signatureBuf)) {
            return { authenticated: false, userId: null, claims: null, error: 'Invalid signature' };
          }
        } else if (alg === 'RS256') {
          const sigBuf = base64UrlToBuffer(signature);
          const verifier = createVerify('RSA-SHA256');
          verifier.update(sigInput);
          if (!verifier.verify(signingKey, sigBuf)) {
            return { authenticated: false, userId: null, claims: null, error: 'Invalid signature' };
          }
        } else {
          return { authenticated: false, userId: null, claims: null, error: `Unsupported algorithm: ${alg}` };
        }
      }

      // Decode payload
      let claims;
      try {
        claims = JSON.parse(base64UrlDecode(parts[1]));
      } catch {
        return { authenticated: false, userId: null, claims: null, error: 'Invalid JWT payload' };
      }

      const userId = extractClaim(claims, claimsPath);
      if (!userId) {
        return { authenticated: false, userId: null, claims, error: `Claim "${claimsPath}" not found in token` };
      }

      return { authenticated: true, userId: String(userId), claims, error: null };
    }
  };
}

/**
 * Admin auth — simple Bearer token comparison.
 * @param {import('http').IncomingMessage} req
 * @param {string} adminKey
 * @returns {{ authenticated: boolean, error: string|null }}
 */
export function authenticateAdmin(req, adminKey) {
  if (!adminKey) {
    return { authenticated: false, error: 'No admin key configured' };
  }
  const authHeader = req.headers?.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { authenticated: false, error: 'Missing or invalid Authorization header' };
  }
  const token = authHeader.slice(7);
  const tokenBuf = Buffer.from(token);
  const keyBuf = Buffer.from(adminKey);
  if (tokenBuf.length !== keyBuf.length || !timingSafeEqual(tokenBuf, keyBuf)) {
    return { authenticated: false, error: 'Invalid admin key' };
  }
  return { authenticated: true, error: null };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf-8');
}

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBuffer(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

function extractClaim(claims, path) {
  const parts = path.split('.');
  let val = claims;
  for (const p of parts) {
    if (val == null || typeof val !== 'object') return null;
    val = val[p];
  }
  return val ?? null;
}
