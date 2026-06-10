import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationRouter } from '../src/mcpl/conversation-router.js';
import type { ChannelDescriptor } from '../src/mcpl/types.js';

const T0 = 1_750_000_000_000;

function makeRouter(overrides: Partial<ConstructorParameters<typeof ConversationRouter>[0]> = {}) {
  return new ConversationRouter({ templateAgent: 'trunk', ...overrides });
}

// ---------------------------------------------------------------------------
// Bind policy
// ---------------------------------------------------------------------------

test('DM message binds without a mention (default dm bind: always)', () => {
  const router = makeRouter();
  const decision = router.route({ channelId: 'slack:D1', mentioned: false, isDm: true, now: T0 });
  assert.equal(decision.kind, 'spawn');
  if (decision.kind === 'spawn') {
    assert.equal(decision.generation, 1);
    assert.match(decision.agentName, /^conversation-slack-D1-g1$/);
    assert.equal(decision.trigger, true);
  }
});

test('channel message without mention stays unbound (default channel bind: mention)', () => {
  const router = makeRouter();
  const decision = router.route({ channelId: 'slack:C1', mentioned: false, isDm: false, now: T0 });
  assert.equal(decision.kind, 'unbound');
});

test('channel mention spawns a fork', () => {
  const router = makeRouter();
  const decision = router.route({ channelId: 'slack:C1', mentioned: true, isDm: false, now: T0 });
  assert.equal(decision.kind, 'spawn');
});

test('bind rule never keeps DMs unbound', () => {
  const router = makeRouter({ bind: { dm: 'never' } });
  const decision = router.route({ channelId: 'slack:D1', mentioned: true, isDm: true, now: T0 });
  assert.equal(decision.kind, 'unbound');
});

// ---------------------------------------------------------------------------
// Spawn is two-phase: route() proposes, bind() commits
// ---------------------------------------------------------------------------

test('spawn decision does not create the binding until bind() is called', () => {
  const router = makeRouter();
  const d1 = router.route({ channelId: 'slack:C1', mentioned: true, isDm: false, now: T0 });
  assert.equal(d1.kind, 'spawn');
  assert.equal(router.getBinding('slack:C1'), undefined);

  // Framework failed to spawn → next mention proposes the same generation.
  const d2 = router.route({ channelId: 'slack:C1', mentioned: true, isDm: false, now: T0 + 1 });
  assert.equal(d2.kind, 'spawn');
  if (d2.kind === 'spawn') assert.equal(d2.generation, 1);

  if (d2.kind === 'spawn') router.bind('slack:C1', d2.agentName, d2.generation, T0 + 1);
  const d3 = router.route({ channelId: 'slack:C1', mentioned: false, isDm: false, now: T0 + 2 });
  assert.equal(d3.kind, 'existing');
});

// ---------------------------------------------------------------------------
// Trigger policy on bound channels
// ---------------------------------------------------------------------------

test('bound channel: non-mentions land without triggering, mentions trigger', () => {
  const router = makeRouter();
  router.bind('slack:C1', 'conversation-slack-C1-g1', 1, T0);

  const ambient = router.route({ channelId: 'slack:C1', mentioned: false, isDm: false, now: T0 + 1 });
  assert.equal(ambient.kind, 'existing');
  if (ambient.kind === 'existing') assert.equal(ambient.trigger, false);

  const mention = router.route({ channelId: 'slack:C1', mentioned: true, isDm: false, now: T0 + 2 });
  assert.equal(mention.kind, 'existing');
  if (mention.kind === 'existing') assert.equal(mention.trigger, true);
});

test('bound DM: every message triggers', () => {
  const router = makeRouter();
  router.bind('slack:D1', 'conversation-slack-D1-g1', 1, T0);
  const decision = router.route({ channelId: 'slack:D1', mentioned: false, isDm: true, now: T0 + 1 });
  assert.equal(decision.kind, 'existing');
  if (decision.kind === 'existing') assert.equal(decision.trigger, true);
});

// ---------------------------------------------------------------------------
// TTL + generations
// ---------------------------------------------------------------------------

test('expired() respects lastActivity refresh from route()', () => {
  const router = makeRouter({ idleTtlMs: 1000 });
  router.bind('slack:C1', 'conversation-slack-C1-g1', 1, T0);

  // Ambient traffic keeps the binding alive even without triggering.
  router.route({ channelId: 'slack:C1', mentioned: false, isDm: false, now: T0 + 900 });
  assert.deepEqual(router.expired(T0 + 1500), []);
  assert.equal(router.expired(T0 + 1901).length, 1);
});

test('rebind after expiry gets a fresh generation and agent name', () => {
  const router = makeRouter({ idleTtlMs: 1000 });
  const d1 = router.route({ channelId: 'slack:C1', mentioned: true, isDm: false, now: T0 });
  if (d1.kind !== 'spawn') assert.fail('expected spawn');
  router.bind('slack:C1', d1.agentName, d1.generation, T0);

  router.unbind('slack:C1'); // framework does this after the closure turn

  const d2 = router.route({ channelId: 'slack:C1', mentioned: true, isDm: false, now: T0 + 5000 });
  assert.equal(d2.kind, 'spawn');
  if (d2.kind === 'spawn') {
    assert.equal(d2.generation, 2);
    assert.match(d2.agentName, /-g2$/);
    assert.notEqual(d2.agentName, d1.agentName);
  }
});

test('channelForAgent reverse lookup', () => {
  const router = makeRouter();
  router.bind('slack:C1', 'fork-a', 1, T0);
  assert.equal(router.channelForAgent('fork-a'), 'slack:C1');
  assert.equal(router.channelForAgent('fork-b'), undefined);
});

// ---------------------------------------------------------------------------
// DM classification
// ---------------------------------------------------------------------------

test('isDmChannel reads descriptor metadata and message channel_type', () => {
  const im: ChannelDescriptor = {
    id: 'slack:D1', type: 'slack', label: 'DM: @alice', direction: 'bidirectional',
    address: {}, metadata: { is_im: true },
  };
  const channel: ChannelDescriptor = {
    id: 'slack:C1', type: 'slack', label: '#general', direction: 'bidirectional',
    address: {}, metadata: { is_member: true },
  };
  assert.equal(ConversationRouter.isDmChannel(im), true);
  assert.equal(ConversationRouter.isDmChannel(channel), false);
  assert.equal(ConversationRouter.isDmChannel(undefined, { channel_type: 'im' }), true);
  assert.equal(ConversationRouter.isDmChannel(undefined, { channel_type: 'mpim' }), true);
  assert.equal(ConversationRouter.isDmChannel(undefined, { channel_type: 'channel' }), false);
  assert.equal(ConversationRouter.isDmChannel(undefined, undefined), false);
});
