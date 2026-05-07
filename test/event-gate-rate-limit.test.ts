import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventGate } from '../src/gate/event-gate.js';
import type { GateConfig, GateEventInfo } from '../src/gate/types.js';

// ---------------------------------------------------------------------------
// Test scaffolding — fake-clock gate, deterministic across runs.
// ---------------------------------------------------------------------------

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-gate-ratelimit');

function tmpPath(name: string): string {
  return join(TMP_DIR, name);
}

interface Harness {
  gate: EventGate;
  advance(ms: number): void;
  setNow(ms: number): void;
}

function makeFakeClockGate(initialConfig: GateConfig, startTime = 1_000_000): Harness {
  let currentTime = startTime;
  mkdirSync(TMP_DIR, { recursive: true });
  const gate = new EventGate({
    configPath: tmpPath(`gate-${Math.random().toString(36).slice(2)}.json`),
    initialConfig,
    emitTrace: () => {},
    addMessage: () => '',
    requestInference: () => {},
    getAgentNames: () => ['agent'],
    now: () => currentTime,
  });
  return {
    gate,
    advance(ms) { currentTime += ms; },
    setNow(ms) { currentTime = ms; },
  };
}

function event(overrides?: Partial<GateEventInfo>): GateEventInfo {
  return {
    content: 'test',
    eventType: 'mcpl:channel-incoming',
    serverId: 'telegram',
    channelId: 'telegram:default:supergroup:1',
    metadata: {},
    ...overrides,
  };
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validation: new behaviors', () => {
  // Validation errors during initialConfig seeding land in getStatus().errors
  // rather than throwing — this matches the existing pattern where a bad
  // gate.json edit doesn't crash the running gate, just reports the issue.
  it('reports rate_limit with non-positive tokens', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'p',
        match: {},
        behavior: { rate_limit: { tokens: 0, refillIntervalMs: 1000 } },
      }],
    });
    const errors = gate.getStatus().errors;
    assert.ok(
      errors.some(e => /tokens must be a positive number/.test(e)),
      `expected validation error, got: ${JSON.stringify(errors)}`,
    );
  });

  it('reports rate_limit with non-positive refillIntervalMs', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'p',
        match: {},
        behavior: { rate_limit: { tokens: 5, refillIntervalMs: -1 } },
      }],
    });
    assert.ok(
      gate.getStatus().errors.some(e => /refillIntervalMs must be a positive number/.test(e)),
    );
  });

  it('reports passive_sample with non-integer every', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'p',
        match: {},
        behavior: { passive_sample: { every: 1.5 } as { every: number } },
      }],
    });
    assert.ok(
      gate.getStatus().errors.some(e => /every must be a positive integer/.test(e)),
    );
  });

  it('accepts well-formed rate_limit and passive_sample without keyBy', () => {
    const { gate } = makeFakeClockGate({
      policies: [
        { name: 'rl', match: {}, behavior: { rate_limit: { tokens: 1, refillIntervalMs: 1000 } } },
      ],
      default: 'skip',
    });
    // With tokens=1, the first call passes, the second is denied.
    assert.strictEqual(gate.evaluate(event()).trigger, true);
    assert.strictEqual(gate.evaluate(event()).trigger, false);
  });
});

// ---------------------------------------------------------------------------
// metadataTrue match
// ---------------------------------------------------------------------------

describe('match: metadataTrue', () => {
  it('matches when ANY listed metadata field is truthy', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'direct',
        match: { metadataTrue: ['isMention', 'isPrivate'] },
        behavior: 'always',
      }],
      default: 'skip',
    });

    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true } })).trigger,
      true,
    );
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isPrivate: true } })).trigger,
      true,
    );
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: false, isPrivate: false } })).trigger,
      false,
    );
    assert.strictEqual(
      gate.evaluate(event({ metadata: {} })).trigger,
      false,
    );
  });

  it('treats empty arrays/strings/objects as falsy (not raw JS Boolean)', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'direct',
        match: { metadataTrue: ['mentionIds'] },
        behavior: 'always',
      }],
      default: 'skip',
    });

    // Empty array — would be truthy under raw Boolean(), but we want falsy.
    assert.strictEqual(
      gate.evaluate(event({ metadata: { mentionIds: [] } })).trigger,
      false,
    );
    // Non-empty array — truthy.
    assert.strictEqual(
      gate.evaluate(event({ metadata: { mentionIds: ['user-99'] } })).trigger,
      true,
    );
    // Empty string — falsy.
    assert.strictEqual(
      gate.evaluate(event({ metadata: { mentionIds: '' } })).trigger,
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// rate_limit
// ---------------------------------------------------------------------------

describe('rate_limit', () => {
  function rlConfig(): GateConfig {
    return {
      policies: [{
        name: 'rl',
        match: { metadataTrue: ['isMention'] },
        behavior: { rate_limit: { tokens: 12, refillIntervalMs: 1000, keyBy: 'senderId' } },
      }],
      default: 'skip',
    };
  }

  it('drains the bucket and denies the 13th invocation in a row', () => {
    const { gate } = makeFakeClockGate(rlConfig());
    for (let i = 0; i < 12; i++) {
      assert.strictEqual(
        gate.evaluate(event({ metadata: { isMention: true, senderId: 'user-1' } })).trigger,
        true,
        `invocation ${i + 1} should pass`,
      );
    }
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'user-1' } })).trigger,
      false,
      '13th invocation must be denied',
    );
  });

  it('regenerates one token per refillIntervalMs', () => {
    const { gate, advance } = makeFakeClockGate(rlConfig());
    for (let i = 0; i < 12; i++) {
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'u' } }));
    }
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'u' } })).trigger,
      false,
    );
    advance(1000);
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'u' } })).trigger,
      true,
      'one token should regenerate after refillIntervalMs',
    );
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'u' } })).trigger,
      false,
      'no second token yet — should still be denied',
    );
  });

  it('caps refill at the configured tokens (no leaking)', () => {
    const { gate, advance } = makeFakeClockGate(rlConfig());
    // drain
    for (let i = 0; i < 12; i++) {
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'u' } }));
    }
    advance(100_000); // way past full refill
    // Should now have full 12 tokens — not 100.
    for (let i = 0; i < 12; i++) {
      assert.strictEqual(
        gate.evaluate(event({ metadata: { isMention: true, senderId: 'u' } })).trigger,
        true,
        `post-refill invocation ${i + 1}`,
      );
    }
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'u' } })).trigger,
      false,
      '13th post-refill invocation should be denied',
    );
  });

  it('keyBy partitions buckets — different users have independent quotas', () => {
    const { gate } = makeFakeClockGate(rlConfig());
    for (let i = 0; i < 12; i++) {
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'user-A' } }));
    }
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'user-A' } })).trigger,
      false,
    );
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'user-B' } })).trigger,
      true,
      'user-B bucket must be independent',
    );
  });

  it('missing keyBy field falls back to a single shared bucket', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'rl',
        match: {},
        behavior: { rate_limit: { tokens: 2, refillIntervalMs: 1000, keyBy: 'senderId' } },
      }],
      default: 'skip',
    });
    // No senderId — these all share the single fallback bucket.
    assert.strictEqual(gate.evaluate(event({ metadata: {} })).trigger, true);
    assert.strictEqual(gate.evaluate(event({ metadata: {} })).trigger, true);
    assert.strictEqual(
      gate.evaluate(event({ metadata: {} })).trigger,
      false,
      'shared bucket should drain like any other',
    );
  });

  it('terminates with trigger:false on deny — does not fall through to default:always', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'rl',
        match: { metadataTrue: ['isMention'] },
        behavior: { rate_limit: { tokens: 1, refillIntervalMs: 1000 } },
      }],
      default: 'always',
    });
    // First passes.
    assert.strictEqual(gate.evaluate(event({ metadata: { isMention: true } })).trigger, true);
    // Second is denied — must NOT fall through to default:always.
    const denied = gate.evaluate(event({ metadata: { isMention: true } }));
    assert.strictEqual(denied.trigger, false);
    assert.strictEqual(denied.policyName, 'rl');
  });
});

// ---------------------------------------------------------------------------
// passive_sample
// ---------------------------------------------------------------------------

describe('passive_sample', () => {
  it('fires every Nth match, then resets', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'ps',
        match: {},
        behavior: { passive_sample: { every: 3 } },
      }],
      default: 'skip',
    });
    assert.strictEqual(gate.evaluate(event()).trigger, false);
    assert.strictEqual(gate.evaluate(event()).trigger, false);
    assert.strictEqual(gate.evaluate(event()).trigger, true);  // 3rd → fires
    assert.strictEqual(gate.evaluate(event()).trigger, false); // counter reset
    assert.strictEqual(gate.evaluate(event()).trigger, false);
    assert.strictEqual(gate.evaluate(event()).trigger, true);  // 6th
  });

  it('keyBy partitions counters — busy channel does not affect quiet one', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'ps',
        match: {},
        behavior: { passive_sample: { every: 3, keyBy: 'channelId' } },
      }],
      default: 'skip',
    });
    // 3 messages in A → 3rd fires
    for (let i = 0; i < 2; i++) {
      assert.strictEqual(
        gate.evaluate(event({ channelId: 'A', metadata: { channelId: 'A' } })).trigger,
        false,
      );
    }
    assert.strictEqual(
      gate.evaluate(event({ channelId: 'A', metadata: { channelId: 'A' } })).trigger,
      true,
    );
    // First message in B → must not fire (counter independent)
    assert.strictEqual(
      gate.evaluate(event({ channelId: 'B', metadata: { channelId: 'B' } })).trigger,
      false,
    );
  });

  it('terminates with trigger:false on non-firing counter — no fallthrough to default', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'ps',
        match: {},
        behavior: { passive_sample: { every: 100 } },
      }],
      default: 'always',
    });
    const decision = gate.evaluate(event());
    assert.strictEqual(decision.trigger, false);
    assert.strictEqual(decision.policyName, 'ps');
  });
});

// ---------------------------------------------------------------------------
// resets cross-policy
// ---------------------------------------------------------------------------

describe('resets', () => {
  it('firing a policy clears the rate_limit and passive_sample state of named targets', () => {
    const config: GateConfig = {
      policies: [
        {
          name: 'direct',
          match: { metadataTrue: ['isMention'] },
          behavior: { rate_limit: { tokens: 12, refillIntervalMs: 1000, keyBy: 'senderId' } },
          resets: ['passive'],
        },
        {
          name: 'passive',
          match: {},
          behavior: { passive_sample: { every: 5 } },
        },
      ],
      default: 'skip',
    };
    const { gate } = makeFakeClockGate(config);

    // 4 quiet messages — passive counter at 4
    for (let i = 0; i < 4; i++) {
      assert.strictEqual(gate.evaluate(event({ metadata: {} })).trigger, false);
    }
    // Direct invocation fires AND resets the passive counter.
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'u' } })).trigger,
      true,
    );
    // Now we need ANOTHER 5 quiet messages, not 1 more.
    for (let i = 0; i < 4; i++) {
      assert.strictEqual(gate.evaluate(event({ metadata: {} })).trigger, false);
    }
    assert.strictEqual(gate.evaluate(event({ metadata: {} })).trigger, true);
  });

  it('denied rate_limit does NOT trigger resets', () => {
    const config: GateConfig = {
      policies: [
        {
          name: 'direct',
          match: { metadataTrue: ['isMention'] },
          behavior: { rate_limit: { tokens: 1, refillIntervalMs: 10_000 } },
          resets: ['passive'],
        },
        {
          name: 'passive',
          match: {},
          behavior: { passive_sample: { every: 3 } },
        },
      ],
      default: 'skip',
    };
    const { gate } = makeFakeClockGate(config);

    // Burn the only token via direct invocation — fires, counter resets to 0
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'u' } })).trigger,
      true,
    );
    // 2 quiet messages — counter at 2
    assert.strictEqual(gate.evaluate(event({ metadata: {} })).trigger, false);
    assert.strictEqual(gate.evaluate(event({ metadata: {} })).trigger, false);
    // Denied direct invocation — must NOT reset counter
    assert.strictEqual(
      gate.evaluate(event({ metadata: { isMention: true, senderId: 'u' } })).trigger,
      false,
    );
    // Next quiet message should still fire (counter was preserved at 2 → reaches 3)
    assert.strictEqual(gate.evaluate(event({ metadata: {} })).trigger, true);
  });

  it('always-behavior with resets clears target state too', () => {
    const config: GateConfig = {
      policies: [
        {
          name: 'priority',
          match: { metadataTrue: ['urgent'] },
          behavior: 'always',
          resets: ['passive'],
        },
        {
          name: 'passive',
          match: {},
          behavior: { passive_sample: { every: 5 } },
        },
      ],
      default: 'skip',
    };
    const { gate } = makeFakeClockGate(config);
    // pile up the passive counter
    for (let i = 0; i < 4; i++) gate.evaluate(event({ metadata: {} }));
    // urgent fires, resets passive
    assert.strictEqual(gate.evaluate(event({ metadata: { urgent: true } })).trigger, true);
    // need full 5 quiet messages now
    for (let i = 0; i < 4; i++) {
      assert.strictEqual(gate.evaluate(event({ metadata: {} })).trigger, false);
    }
    assert.strictEqual(gate.evaluate(event({ metadata: {} })).trigger, true);
  });

  it('unknown reset target is silently ignored', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'p',
        match: {},
        behavior: 'always',
        resets: ['nonexistent', 'also-fake'],
      }],
      default: 'skip',
    });
    // Should not throw
    assert.strictEqual(gate.evaluate(event()).trigger, true);
  });
});

// ---------------------------------------------------------------------------
// status reporting
// ---------------------------------------------------------------------------

describe('gate:status with new behaviors', () => {
  it('exposes rate-limit bucketCount + deniedCount', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'rl',
        match: {},
        behavior: { rate_limit: { tokens: 1, refillIntervalMs: 10_000, keyBy: 'k' } },
      }],
      default: 'skip',
    });
    gate.evaluate(event({ metadata: { k: 'a' } })); // creates bucket A, consumes
    gate.evaluate(event({ metadata: { k: 'b' } })); // creates bucket B, consumes
    gate.evaluate(event({ metadata: { k: 'a' } })); // denied
    const status = gate.getStatus();
    const policy = status.policies.find(p => p.name === 'rl');
    assert.ok(policy);
    assert.strictEqual(policy.rateLimitState?.bucketCount, 2);
    assert.strictEqual(policy.rateLimitState?.deniedCount, 1);
  });

  it('exposes passive-sample counterCount + fireCount', () => {
    const { gate } = makeFakeClockGate({
      policies: [{
        name: 'ps',
        match: {},
        behavior: { passive_sample: { every: 2, keyBy: 'k' } },
      }],
      default: 'skip',
    });
    gate.evaluate(event({ metadata: { k: 'A' } })); // count 1
    gate.evaluate(event({ metadata: { k: 'A' } })); // fires; reset to 0
    gate.evaluate(event({ metadata: { k: 'B' } })); // count 1 in B
    const status = gate.getStatus();
    const policy = status.policies.find(p => p.name === 'ps');
    assert.ok(policy);
    // 2 keys touched (A and B), 1 fire so far
    assert.strictEqual(policy.passiveSampleState?.counterCount, 2);
    assert.strictEqual(policy.passiveSampleState?.fireCount, 1);
  });
});
