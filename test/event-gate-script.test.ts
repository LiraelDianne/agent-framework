import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventGate } from '../src/gate/event-gate.js';
import type { GateConfig, GateEventInfo } from '../src/gate/types.js';

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-gate-script');

function makeGate(scriptSrc: string | null, config: GateConfig, scriptTimeoutMs = 200) {
  mkdirSync(TMP_DIR, { recursive: true });
  const configPath = join(TMP_DIR, 'gate.json');
  writeFileSync(configPath, JSON.stringify(config));
  if (scriptSrc !== null) writeFileSync(join(TMP_DIR, 'gate.js'), scriptSrc);
  return new EventGate({
    configPath,
    scriptTimeoutMs,
    emitTrace: () => {},
    addMessage: () => '',
    requestInference: () => {},
    getAgentNames: () => ['agent'],
  });
}

function ev(over?: Partial<GateEventInfo>): GateEventInfo {
  return { content: 'x', eventType: 'mcpl:push-event', serverId: 'discord', channelId: 'c1', tags: [], ...over };
}

// The worker imports gate.js asynchronously; wait until the gate reports ready.
async function waitReady(gate: EventGate): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (gate.getStatus().script.ready) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('gate.js worker never became ready');
}

beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
afterEach(() => { if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true }); });

describe('gate.js programmable gate', () => {
  it('script decision takes precedence; null falls through to declarative', async () => {
    const gate = makeGate(
      `export default (e) => e.channelId === 'vip' ? 'always' : (e.tags.includes('chat:ambient') ? { debounce: 1000 } : null);`,
      { policies: [{ name: 'mention', match: { tagsAny: ['chat:mention'] }, behavior: 'always' }], default: 'defer' },
    );
    try {
      await waitReady(gate);
      // script says always for vip
      assert.strictEqual(gate.evaluate(ev({ channelId: 'vip' })).policyName, 'gate.js');
      assert.strictEqual(gate.evaluate(ev({ channelId: 'vip' })).trigger, true);
      // script debounces ambient
      const amb = gate.evaluate(ev({ tags: ['chat:ambient'] }));
      assert.strictEqual(amb.policyName, 'gate.js');
      assert.strictEqual(amb.trigger, false);
      // script returns null → declarative 'mention' policy applies
      const men = gate.evaluate(ev({ tags: ['chat:mention'] }));
      assert.strictEqual(men.policyName, 'mention');
      assert.strictEqual(men.trigger, true);
      // script null, no policy → default defer
      assert.strictEqual(gate.evaluate(ev({ tags: [] })).trigger, false);
    } finally {
      gate.dispose();
    }
  });

  it('a throwing script falls through and surfaces the error', async () => {
    const gate = makeGate(
      `export default () => { throw new Error('boom'); };`,
      { policies: [], default: 'always' },
    );
    try {
      await waitReady(gate);
      const d = gate.evaluate(ev());
      assert.strictEqual(d.trigger, true); // fell through to default 'always'
      assert.match(gate.getStatus().script.lastError ?? '', /boom/);
    } finally {
      gate.dispose();
    }
  });

  it('an infinite-loop script times out, falls through, and is recorded', async () => {
    const gate = makeGate(
      `export default () => { while (true) {} };`,
      { policies: [], default: 'always' },
      80,
    );
    try {
      await waitReady(gate);
      const d = gate.evaluate(ev());
      assert.strictEqual(d.trigger, true); // timed out → fell through to default
      assert.ok(gate.getStatus().script.timeouts >= 1);
    } finally {
      gate.dispose();
    }
  });

  it('no gate.js → script inactive, declarative gate works normally', () => {
    const gate = makeGate(null, { policies: [], default: 'defer' });
    try {
      assert.strictEqual(gate.getStatus().script.active, false);
      assert.strictEqual(gate.evaluate(ev()).trigger, false);
    } finally {
      gate.dispose();
    }
  });
});
