import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

/**
 * Desired-state provenance: a server upgrading its descriptor to
 * initiallyOpen may lift a pure default ('default-closed' = nobody ever
 * decided), but must never override a real decision (agent-tool,
 * invitation-declined). Regression for the eidoverse-worlds case where a
 * resident's world channel stayed shadow-closed forever because the default
 * predated the server declaring its bootstrap preference.
 */

function makeRegistry() {
  const serverRegistry = {
    getServer: (_id: string) => ({ sendChannelsPublish: async () => ({ delivered: true }) }),
  } as unknown as McplServerRegistry;
  const registry = new ChannelRegistry(
    serverRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
  );
  const r = registry as unknown as {
    ensureInitialDesiredState(serverId: string, ch: { id: string; type: string; label: string; direction: string; initiallyOpen?: boolean }): void;
    setDesiredState(serverId: string, channelId: string, desired: 'open' | 'closed', source: string): void;
    getDesiredState(serverId: string, channelId: string): 'open' | 'closed' | undefined;
  };
  return { registry, r };
}

const ch = (initiallyOpen?: boolean) => ({
  id: 'world:commons', type: 'world', label: 'eidoverse — commons', direction: 'bidirectional', initiallyOpen,
});

test('default-closed is lifted when the server later declares initiallyOpen', () => {
  const { r } = makeRegistry();
  // first registration: server said nothing → default-closed
  r.ensureInitialDesiredState('eidoverse', ch(undefined));
  assert.equal(r.getDesiredState('eidoverse', 'world:commons'), 'closed');
  // server upgrades its descriptor: bootstrap preference lifts the pure default
  r.ensureInitialDesiredState('eidoverse', ch(true));
  assert.equal(r.getDesiredState('eidoverse', 'world:commons'), 'open');
});

test('an agent decision to close is never overridden by initiallyOpen', () => {
  const { r } = makeRegistry();
  r.ensureInitialDesiredState('eidoverse', ch(true));
  assert.equal(r.getDesiredState('eidoverse', 'world:commons'), 'open');
  // the agent deliberately closes their door
  r.setDesiredState('eidoverse', 'world:commons', 'closed', 'agent-tool');
  // server keeps declaring initiallyOpen — the decision sticks
  r.ensureInitialDesiredState('eidoverse', ch(true));
  assert.equal(r.getDesiredState('eidoverse', 'world:commons'), 'closed');
});

test('initiallyOpen at first sight registers open with server-bootstrap provenance', () => {
  const { r } = makeRegistry();
  r.ensureInitialDesiredState('eidoverse', ch(true));
  assert.equal(r.getDesiredState('eidoverse', 'world:commons'), 'open');
});
