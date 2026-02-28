import { vi } from 'vitest';

/**
 * Factory for a minimal view context mock suitable for unit tests.
 * @param {object} [overrides] - Optional property overrides.
 * @returns {object}
 */
export function makeViewContext(overrides = {}) {
  return {
    screen: { key: vi.fn(), unkey: vi.fn(), render: vi.fn(), focused: null, rows: 40 },
    content: { append: vi.fn(), remove: vi.fn() },
    config: {},
    navigate: vi.fn(),
    setFooter: vi.fn(),
    screenKey: vi.fn(),
    openPopup: vi.fn(),
    closePopup: vi.fn(),
    startService: vi.fn(),
    ...overrides
  };
}
