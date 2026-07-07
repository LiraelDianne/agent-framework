/**
 * gatherContext per-module timeout (3.5): the flat 5s default silently
 * dropped any module whose gatherContext does real work (e.g. a retrieval
 * module making 2 sequential LLM calls with provider backoff) — fail-open
 * meant "guaranteed timeout, every turn, invisibly".
 *
 * A module can now declare `contextTimeoutMs` for its own budget; the
 * registry default was raised to 15s. Fail-open behavior is preserved for
 * modules that actually exceed their budget.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModuleRegistry } from '../src/module-registry.js';
import type { Module } from '../src/types/index.js';

function makeRegistry(modules: Module[]): ModuleRegistry {
  const registry = Object.create(ModuleRegistry.prototype) as ModuleRegistry;
  (registry as any).modules = new Map(modules.map((m) => [m.name, m]));
  return registry;
}

function slowModule(name: string, delayMs: number, contextTimeoutMs?: number): Module {
  return {
    name,
    ...(contextTimeoutMs !== undefined ? { contextTimeoutMs } : {}),
    start: async () => {},
    stop: async () => {},
    getTools: () => [],
    handleToolCall: async () => ({ success: true }),
    onProcess: async () => ({}),
    gatherContext: async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return [{
        namespace: name,
        position: 'system' as const,
        content: [{ type: 'text' as const, text: `from ${name}` }],
      }];
    },
  };
}

test('a module slower than the shared default completes within its own contextTimeoutMs', async () => {
  // Registry default budget of 100ms, module takes 300ms but declares 1000ms.
  const registry = makeRegistry([slowModule('retrieval', 300, 1000)]);

  const injections = await registry.gatherContext('agent', 100);
  assert.equal(injections.length, 1, 'the slow module must inject, not silently time out');
  assert.deepEqual(injections[0].content, [{ type: 'text', text: 'from retrieval' }]);
});

test('a module exceeding its own budget still fails open (skipped, no throw)', async () => {
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
  try {
    const registry = makeRegistry([slowModule('laggard', 500, 50)]);
    const injections = await registry.gatherContext('agent', 5000);
    assert.equal(injections.length, 0);
    assert.ok(errs.some((e) => e.includes('[laggard]') && e.includes('timed out after 50ms')));
  } finally {
    console.error = orig;
  }
});

test('modules without contextTimeoutMs use the shared default; fast ones are unaffected', async () => {
  const registry = makeRegistry([
    slowModule('fast', 10),
    slowModule('slow-no-override', 400),
  ]);

  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
  try {
    const injections = await registry.gatherContext('agent', 100);
    assert.equal(injections.length, 1, 'only the fast module injects');
    assert.deepEqual(injections[0].content, [{ type: 'text', text: 'from fast' }]);
  } finally {
    console.error = orig;
  }
});

test('per-module budgets run in parallel — total time is bounded by the largest budget, not the sum', async () => {
  const registry = makeRegistry([
    slowModule('a', 150, 1000),
    slowModule('b', 150, 1000),
    slowModule('c', 150, 1000),
  ]);
  const started = Date.now();
  const injections = await registry.gatherContext('agent', 100);
  const elapsed = Date.now() - started;
  assert.equal(injections.length, 3);
  assert.ok(elapsed < 450, `parallel gather took ${elapsed}ms`);
});
