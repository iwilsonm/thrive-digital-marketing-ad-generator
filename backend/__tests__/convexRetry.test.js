import { describe, expect, it } from 'vitest';
import { convexShouldRetry } from '../convexClient.js';

describe('convexShouldRetry', () => {
  it('retries the Convex InternalServerError JSON platform shape', () => {
    const err = new Error('{"code":"InternalServerError","message":"Your request couldn\'t be completed. Try again later."}');

    expect(convexShouldRetry(err)).toBe(true);
  });

  it('does not retry Convex validator/application errors', () => {
    expect(convexShouldRetry(new Error('ArgumentValidationError: Value does not match validator'))).toBe(false);
    expect(convexShouldRetry(new Error('Object is missing the required field xyz'))).toBe(false);
  });

  it('keeps existing retryable Convex transient patterns', () => {
    expect(convexShouldRetry(new Error('Server Error'))).toBe(true);
    expect(convexShouldRetry(new Error('fetch failed'))).toBe(true);
    expect(convexShouldRetry(new Error('Convex overloaded'))).toBe(true);
  });
});
