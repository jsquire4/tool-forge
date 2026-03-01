import { describe, it, expect } from 'vitest';
import { all, any, not } from './compose.js';

const pass = async () => ({ pass: true });
// Factory: fail('reason') returns a grader function, not a Promise
const fail = (reason = 'reason') => async () => ({ pass: false, reason });

describe('all', () => {
  it('passes when all graders pass', async () => {
    expect((await all([pass, pass])({})).pass).toBe(true);
  });
  it('fails when any grader fails', async () => {
    const r = await all([pass, fail('oops')])({});
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('oops');
  });
  it('concatenates failure reasons', async () => {
    const r = await all([fail('a'), fail('b')])({});
    expect(r.reason).toContain('a');
    expect(r.reason).toContain('b');
  });
  it('passes with a single passing grader', async () => {
    expect((await all([pass])({})).pass).toBe(true);
  });
  it('fails with a single failing grader', async () => {
    const r = await all([fail('only one')])({});
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('only one');
  });
  it('passes with empty grader list', async () => {
    expect((await all([])({})).pass).toBe(true);
  });
  it('forwards input to each grader', async () => {
    const seen = [];
    const capture = async (input) => { seen.push(input); return { pass: true }; };
    await all([capture, capture])({ x: 1 });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ x: 1 });
  });
});

describe('any', () => {
  it('passes when at least one grader passes', async () => {
    expect((await any([fail(), pass])({})).pass).toBe(true);
  });
  it('fails when all graders fail', async () => {
    expect((await any([fail('x'), fail('y')])({})).pass).toBe(false);
  });
  it('passes when the first grader passes', async () => {
    expect((await any([pass, fail()])({})).pass).toBe(true);
  });
  it('includes all failure reasons when every grader fails', async () => {
    const r = await any([fail('err1'), fail('err2')])({});
    expect(r.reason).toContain('err1');
    expect(r.reason).toContain('err2');
  });
  it('passes with a single passing grader', async () => {
    expect((await any([pass])({})).pass).toBe(true);
  });
});

describe('not', () => {
  it('passes when original grader fails', async () => {
    expect((await not(fail())({})).pass).toBe(true);
  });
  it('fails when original grader passes', async () => {
    expect((await not(pass)({})).pass).toBe(false);
  });
  it('includes a descriptive reason when it fails', async () => {
    const r = await not(pass)({});
    expect(r.reason).toBeTruthy();
    expect(typeof r.reason).toBe('string');
  });
  it('forwards input to the inner grader', async () => {
    let seen;
    const capture = async (input) => { seen = input; return { pass: false }; };
    await not(capture)({ sentinel: true });
    expect(seen).toEqual({ sentinel: true });
  });
});
