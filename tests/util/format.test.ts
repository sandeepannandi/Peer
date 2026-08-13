import { describe, expect, it } from 'vitest';

import { truncate } from '../../src/util/format.js';

describe('truncate', () => {
  it('returns short text unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates long text with an ellipsis', () => {
    expect(truncate('hello world', 8)).toBe('hello...');
  });

  it('returns exactly max characters when truncated', () => {
    expect(truncate('a very long string', 10)).toHaveLength(10);
  });

  it('returns an empty string for a non-positive max', () => {
    expect(truncate('hello', 0)).toBe('');
    expect(truncate('hello', -1)).toBe('');
  });
});
