import { describe, it } from 'node:test';
import assert from 'node:assert';

import { CheckpointManager } from '../src/mcpl/checkpoint-manager.js';

// Minimal in-memory JsStore covering the slots CheckpointManager touches.
function fakeStore(): any {
  const m = new Map<string, unknown>();
  return {
    registerState(_opts: { id: string; strategy: string }) {},
    getStateJson(id: string) { return m.has(id) ? m.get(id) : null; },
    setStateJson(id: string, v: unknown) { m.set(id, v); },
  };
}

describe('CheckpointManager host-managed attribution', () => {
  it('threads the host-managed set even when a server-managed set registers first', () => {
    const cm = new CheckpointManager(fakeStore(), () => {});
    const srv = 'xgate';
    // Mirror x-mcpl's declaration order: x.post (rollback) BEFORE x.feed (host).
    cm.registerFeatureSet(srv, 'x.post', { hostState: false, rollback: true });
    cm.registerFeatureSet(srv, 'x.feed', { hostState: true, rollback: true });
    cm.registerFeatureSet(srv, 'x.dm', { hostState: false, rollback: true });

    // The old blind "first stateful" pick returns x.post (the bug); the fix
    // selects the host-managed set for state threading.
    assert.equal(cm.getStatefulFeatureSet(srv), 'x.post');
    assert.equal(cm.getHostManagedFeatureSet(srv), 'x.feed');

    // A tagged feed checkpoint lands on x.feed and is retrievable for injection.
    cm.recordCheckpoint(srv, 'x.feed', {
      checkpoint: '1', parent: null, featureSet: 'x.feed', data: { sources: ['alice'] },
    });
    assert.deepEqual(cm.getCurrentState(srv, 'x.feed'), { sources: ['alice'] });
    // The server-managed set is not polluted by the feed's state.
    assert.equal(cm.getCurrentState(srv, 'x.post'), undefined);
  });

  it('getHostManagedFeatureSet is null when the server has no host-managed set', () => {
    const cm = new CheckpointManager(fakeStore(), () => {});
    cm.registerFeatureSet('s', 'x.post', { hostState: false, rollback: true });
    assert.equal(cm.getHostManagedFeatureSet('s'), null);
    assert.equal(cm.getStatefulFeatureSet('s'), 'x.post');
  });
});
