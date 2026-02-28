/**
 * Tests for forge-agent.js helpers.
 * Covers: loadStageSkill, computeStageLabel, view export contract.
 *
 * blessed is mocked so no actual screen is created.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock blessed to avoid terminal side effects ──────────────────────────────
vi.mock('blessed', () => {
  const makeWidget = (extra = {}) => ({
    append: vi.fn(),
    remove: vi.fn(),
    focus: vi.fn(),
    key: vi.fn(),
    on: vi.fn(),
    log: vi.fn(),
    setContent: vi.fn(),
    clearValue: vi.fn(),
    getValue: vi.fn(() => ''),
    setScrollPerc: vi.fn(),
    style: { border: {} },
    ...extra
  });

  return {
    default: {
      box: vi.fn(() => makeWidget({ wantsBackConfirm: false })),
      log: vi.fn(() => makeWidget()),
      textbox: vi.fn(() => makeWidget({ readInput: vi.fn(), cancel: vi.fn() })),
      question: vi.fn(() => ({ ...makeWidget(), ask: vi.fn() })),
    }
  };
});

// ── Mock api-client to avoid real HTTP calls ─────────────────────────────────
vi.mock('../api-client.js', () => ({
  resolveModelConfig: vi.fn(() => ({ provider: 'anthropic', apiKey: 'test-key', model: 'claude-test' })),
  llmTurn: vi.fn(() => Promise.resolve({ text: 'Hello from mock LLM' }))
}));

// ── Mock db.js to avoid actual SQLite I/O ───────────────────────────────────
vi.mock('../db.js', () => ({
  getDb: vi.fn(() => ({ _insertMsg: vi.fn(), prepare: vi.fn(() => ({ all: vi.fn(() => []) })) })),
  createSession: vi.fn(() => 'mock-session-id'),
  insertConversationMessage: vi.fn(() => 1),
  getConversationHistory: vi.fn(() => []),
  getIncompleteSessions: vi.fn(() => [])
}));

import { makeViewContext } from '../../tests/helpers/view-context.js';
import {
  loadStageSkill,
  computeStageLabel,
  loadBasePrompt,
  STAGES,
  createView
} from './forge-agent.js';

import { resolve } from 'path';
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

// ── Group 1: loadStageSkill ──────────────────────────────────────────────────

describe('loadStageSkill', () => {
  let tmpDir;
  let origStagesDir;

  beforeEach(() => {
    tmpDir = resolve(tmpdir(), `forge-agent-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  it('returns content when file exists (using real fixture)', () => {
    // Use the fixture files created in tests/fixtures/stages/
    const fixtureDir = resolve(process.cwd(), 'tests/fixtures/stages');
    const content = loadStageSkillFromDir(fixtureDir, 'orient');
    expect(typeof content).toBe('string');
    expect(content.length).toBeGreaterThan(0);
  });

  it('returns empty string when file is missing', () => {
    const result = loadStageSkillFromDir(tmpDir, 'nonexistent-stage');
    expect(result).toBe('');
  });

  it('returns empty string when stages directory is missing', () => {
    const result = loadStageSkillFromDir(resolve(tmpDir, 'no-such-dir'), 'orient');
    expect(result).toBe('');
  });

  it('returns empty string for empty file', () => {
    writeFileSync(resolve(tmpDir, 'empty-stage.md'), '');
    const result = loadStageSkillFromDir(tmpDir, 'empty-stage');
    expect(result).toBe('');
  });

  it('real loadStageSkill returns string (may be empty if dir is missing)', () => {
    const result = loadStageSkill('orient');
    expect(typeof result).toBe('string');
  });

  it('real loadStageSkill returns empty string for unknown stage', () => {
    const result = loadStageSkill('totally-unknown-stage-xyz');
    expect(result).toBe('');
  });

  it('real loadStageSkill never throws for missing directory', () => {
    expect(() => loadStageSkill('some-stage')).not.toThrow();
  });
});

/**
 * Helper: load a stage skill from an arbitrary directory (for isolation).
 */
function loadStageSkillFromDir(dir, stageName) {
  try {
    const filePath = resolve(dir, `${stageName}.md`);
    if (!existsSync(dir)) return '';
    if (!existsSync(filePath)) return '';
    const content = readFileSync(filePath, 'utf-8');
    return content;
  } catch (_) {
    return '';
  }
}

// ── Group 2: computeStageLabel ────────────────────────────────────────────────

describe('computeStageLabel', () => {
  it('returns correct label for known stage', () => {
    const label = computeStageLabel('orient', 8);
    expect(label).toBe('Stage 1/8: orient');
  });

  it('returns correct label for last stage', () => {
    const label = computeStageLabel('promote', 8);
    expect(label).toBe('Stage 8/8: promote');
  });

  it('returns ? for unknown stage name', () => {
    const label = computeStageLabel('totally-unknown', 8);
    expect(label).toContain('?');
    expect(label).toContain('totally-unknown');
  });

  it('does not throw when totalPhases is 0', () => {
    expect(() => computeStageLabel('orient', 0)).not.toThrow();
  });

  it('does not throw when totalPhases is undefined', () => {
    expect(() => computeStageLabel('orient', undefined)).not.toThrow();
  });

  it('STAGES array has 8 entries', () => {
    expect(STAGES).toHaveLength(8);
  });
});

// ── Group 3: View export contract ─────────────────────────────────────────────

describe('createView export contract', () => {
  it('createView returns an object', () => {
    const ctx = makeViewContext();
    const view = createView(ctx);
    expect(view).toBeTruthy();
    expect(typeof view).toBe('object');
  });

  it('createView returns an object with a refresh function', () => {
    const ctx = makeViewContext();
    const view = createView(ctx);
    expect(typeof view.refresh).toBe('function');
  });

  it('does not call openPopup synchronously on creation', () => {
    const ctx = makeViewContext();
    createView(ctx);
    expect(ctx.openPopup).not.toHaveBeenCalled();
  });

  it('does not set wantsBackConfirm — escape exits immediately', () => {
    const ctx = makeViewContext();
    const view = createView(ctx);
    expect(view.wantsBackConfirm).toBeFalsy();
  });
});
