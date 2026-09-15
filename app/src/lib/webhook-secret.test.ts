import { describe, it, expect } from 'vitest';
import { tokensMatch } from './webhook-secret';

describe('tokensMatch (webhook auth, constant-time)', () => {
  it('matches identical tokens', () => {
    expect(tokensMatch('abc123', 'abc123')).toBe(true);
  });

  it('rejects different tokens of equal length', () => {
    expect(tokensMatch('abc123', 'abc124')).toBe(false);
  });

  it('rejects length mismatches', () => {
    expect(tokensMatch('abc', 'abcd')).toBe(false);
    expect(tokensMatch('abcd', 'abc')).toBe(false);
  });

  it('rejects empty / missing provided tokens', () => {
    expect(tokensMatch(null, 'secret')).toBe(false);
    expect(tokensMatch(undefined, 'secret')).toBe(false);
    expect(tokensMatch('', 'secret')).toBe(false);
  });
});
