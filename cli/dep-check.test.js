import { describe, it, expect, vi } from 'vitest';
import {
  checkDependency,
  installHint,
  requireDependency,
  ensureDependencyInteractive,
} from './dep-check.js';

describe('dep-check', () => {
  describe('checkDependency', () => {
    it('returns available: true for an installed package', async () => {
      const result = await checkDependency('better-sqlite3');
      expect(result.available).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('returns available: false for a nonexistent package', async () => {
      const result = await checkDependency('nonexistent-xyz-pkg-12345');
      expect(result.available).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('installHint', () => {
    it('returns npm install command for package', () => {
      const hint = installHint('redis');
      expect(hint).toBe('npm install redis');
    });

    it('returns npm install command for pg', () => {
      expect(installHint('pg')).toBe('npm install pg');
    });
  });

  describe('requireDependency', () => {
    it('resolves for an installed package', async () => {
      await expect(requireDependency('better-sqlite3')).resolves.toBeUndefined();
    });

    it('throws with install hint for missing package', async () => {
      await expect(requireDependency('nonexistent-xyz-pkg-12345')).rejects.toThrow(
        /npm install nonexistent-xyz-pkg-12345/
      );
    });
  });

  describe('ensureDependencyInteractive', () => {
    it('returns true immediately when package is available', async () => {
      const rl = { question: vi.fn() };
      const result = await ensureDependencyInteractive('better-sqlite3', rl);
      expect(result).toBe(true);
      expect(rl.question).not.toHaveBeenCalled();
    });

    it('returns false when user declines install', async () => {
      const rl = {
        question: vi.fn((_prompt, cb) => cb('n')),
      };
      const result = await ensureDependencyInteractive('nonexistent-xyz-pkg-12345', rl);
      expect(result).toBe(false);
    });
  });
});
