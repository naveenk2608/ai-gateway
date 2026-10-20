import { describe, expect, it } from 'vitest';
import { isTransientDbError } from './consumer.js';

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('isTransientDbError', () => {
  it.each([
    withCode('connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED'),
    withCode('terminating connection due to administrator command', '57P01'),
    withCode('the database system is starting up', '57P03'),
    withCode('connection failure', '08006'),
    new Error('Connection terminated unexpectedly'),
    new Error('timeout exceeded when trying to connect'),
  ])('retries in place for %s', (err) => {
    expect(isTransientDbError(err)).toBe(true);
  });

  it.each([
    withCode('insert or update violates foreign key constraint', '23503'),
    withCode('invalid input syntax for type uuid', '22P02'),
    new Error('something else'),
    'not an error',
  ])('does not retry %s', (err) => {
    expect(isTransientDbError(err)).toBe(false);
  });
});
