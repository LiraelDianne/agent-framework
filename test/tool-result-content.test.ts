/**
 * toMembraneToolResult (6.6): JSON.stringify(undefined) returns the VALUE
 * undefined, not a string — a tool returning `{ success: true }` with no data
 * plus a configured maxChars cap used to throw a TypeError on content.length
 * mid-turn. It must degrade to a safe empty string instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentFramework } from '../src/framework.js';

function makeFw() {
  return Object.create(AgentFramework.prototype) as any;
}

test('undefined data + maxChars cap: no throw, content is a safe string', () => {
  const fw = makeFw();
  const result = fw.toMembraneToolResult('call-1', { success: true }, 1000);
  assert.equal(result.toolUseId, 'call-1');
  assert.equal(result.isError, false);
  assert.equal(result.content, '');
});

test('undefined data without a cap also yields a string (never the value undefined)', () => {
  const fw = makeFw();
  const result = fw.toMembraneToolResult('call-2', { success: true, data: undefined });
  assert.equal(typeof result.content, 'string');
});

test('normal data is still stringified and truncated by the cap', () => {
  const fw = makeFw();
  const result = fw.toMembraneToolResult('call-3', { success: true, data: { v: 'y'.repeat(500) } }, 100);
  assert.equal(typeof result.content, 'string');
  assert.match(result.content, /\[truncated — original was \d+ chars\]/);
});

test('error results pass through unchanged', () => {
  const fw = makeFw();
  const result = fw.toMembraneToolResult('call-4', { success: false, error: 'boom', isError: true }, 100);
  assert.equal(result.isError, true);
  assert.equal(result.content, 'boom');
});
