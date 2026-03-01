import { describe, it, expect } from 'vitest';
import { CONFIG_DEFAULTS, mergeDefaults, validateConfig } from './config-schema.js';

describe('config-schema', () => {
  describe('mergeDefaults', () => {
    it('returns full defaults when given empty object', () => {
      const config = mergeDefaults({});
      expect(config.auth.mode).toBe('trust');
      expect(config.defaultModel).toBe('claude-sonnet-4-6');
      expect(config.defaultHitlLevel).toBe('cautious');
      expect(config.conversation.window).toBe(25);
      expect(config.sidecar.port).toBe(8001);
      expect(config.database.type).toBe('sqlite');
      expect(config.database.url).toBeNull();
    });

    it('overrides scalar values', () => {
      const config = mergeDefaults({ defaultModel: 'gpt-4o', adminKey: 'secret', auth: { mode: 'trust' } });
      expect(config.defaultModel).toBe('gpt-4o');
      expect(config.adminKey).toBe('secret');
      // explicitly set to trust
      expect(config.auth.mode).toBe('trust');
    });

    it('mergeDefaults(null) does not throw and returns defaults', () => {
      const config = mergeDefaults(null);
      expect(config.auth.mode).toBe('trust');
      expect(config.defaultModel).toBe('claude-sonnet-4-6');
    });

    it('auth.mode defaults to "trust" (zero-config safe default)', () => {
      const config = mergeDefaults({});
      expect(config.auth.mode).toBe('trust');
    });

    it('deep merges nested objects', () => {
      const config = mergeDefaults({ auth: { mode: 'verify', signingKey: 'key123' } });
      expect(config.auth.mode).toBe('verify');
      expect(config.auth.signingKey).toBe('key123');
      expect(config.auth.claimsPath).toBe('sub'); // preserved from defaults
    });

    it('overrides arrays entirely (no merge)', () => {
      const config = mergeDefaults({ conversation: { store: 'redis', redis: { url: 'redis://localhost' } } });
      expect(config.conversation.store).toBe('redis');
      expect(config.conversation.window).toBe(25); // preserved from defaults
    });

    it('handles undefined input', () => {
      const config = mergeDefaults();
      expect(config).toEqual(CONFIG_DEFAULTS);
    });
  });

  describe('validateConfig', () => {
    it('passes valid config', () => {
      const { valid, errors } = validateConfig({
        auth: { mode: 'trust' },
        defaultHitlLevel: 'standard',
        conversation: { store: 'sqlite', window: 10 },
        sidecar: { port: 9000 }
      });
      expect(valid).toBe(true);
      expect(errors).toHaveLength(0);
    });

    it('rejects invalid auth.mode', () => {
      const { valid, errors } = validateConfig({ auth: { mode: 'invalid' } });
      expect(valid).toBe(false);
      expect(errors[0]).toContain('auth.mode');
    });

    it('requires signingKey when auth.mode is verify', () => {
      const { valid, errors } = validateConfig({ auth: { mode: 'verify' } });
      expect(valid).toBe(false);
      expect(errors.some(e => e.includes('signingKey'))).toBe(true);
    });

    it('rejects invalid defaultHitlLevel', () => {
      const { valid, errors } = validateConfig({ defaultHitlLevel: 'yolo' });
      expect(valid).toBe(false);
      expect(errors[0]).toContain('defaultHitlLevel');
    });

    it('accepts valid database.type values', () => {
      expect(validateConfig({ database: { type: 'sqlite' } }).valid).toBe(true);
      expect(validateConfig({ database: { type: 'postgres' } }).valid).toBe(true);
    });

    it('rejects invalid database.type', () => {
      const { valid, errors } = validateConfig({ database: { type: 'mongodb' } });
      expect(valid).toBe(false);
      expect(errors[0]).toContain('database.type');
    });

    it('rejects invalid conversation.store', () => {
      const { valid, errors } = validateConfig({ conversation: { store: 'mongodb' } });
      expect(valid).toBe(false);
      expect(errors[0]).toContain('conversation.store');
    });

    it('rejects invalid sidecar.port', () => {
      const r1 = validateConfig({ sidecar: { port: 0 } });
      expect(r1.valid).toBe(false);

      const r2 = validateConfig({ sidecar: { port: 99999 } });
      expect(r2.valid).toBe(false);

      const r3 = validateConfig({ sidecar: { port: 3.5 } });
      expect(r3.valid).toBe(false);
    });

    it('rejects invalid conversation.window', () => {
      const { valid } = validateConfig({ conversation: { window: -1 } });
      expect(valid).toBe(false);
    });

    it('passes with empty/undefined config', () => {
      expect(validateConfig({}).valid).toBe(true);
      expect(validateConfig().valid).toBe(true);
    });

    it('startup validation fails when sidecar enabled + verify mode + no signingKey', () => {
      const { valid, errors } = validateConfig({
        sidecar: { enabled: true },
        auth: { mode: 'verify' },
      });
      expect(valid).toBe(false);
      expect(errors.some(e => e.includes('signingKey') && e.includes('sidecar'))).toBe(true);
    });
  });
});
