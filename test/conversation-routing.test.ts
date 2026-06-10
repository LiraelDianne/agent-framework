/**
 * Integration tests for per-channel conversation routing: incoming MCPL
 * channel messages spawn/route to fork agents instead of the primary
 * conversation when FrameworkConfig.conversations is set.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { ProcessEvent } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

function incomingEvent(overrides: {
  channelId: string;
  text: string;
  mentioned?: boolean;
  channelType?: string;
  messageId?: string;
}): ProcessEvent {
  return {
    type: 'mcpl:channel-incoming',
    serverId: 'srv',
    channelId: overrides.channelId,
    messageId: overrides.messageId ?? `m-${Math.random().toString(36).slice(2)}`,
    author: { id: 'U1', name: 'alice' },
    content: [{ type: 'text', text: overrides.text }],
    timestamp: new Date().toISOString(),
    metadata: {
      mentioned: overrides.mentioned ?? false,
      ...(overrides.channelType ? { channel_type: overrides.channelType } : {}),
    },
    triggerInference: true,
  } as unknown as ProcessEvent;
}

describe('Conversation routing', () => {
  let tempDir: string;
  let membrane: MockMembrane;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'conv-routing-test-'));
    membrane = new MockMembrane();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function makeFramework(conversations: Record<string, unknown> = {}) {
    return AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'trunk', model: 'test-model', systemPrompt: 'You are the trunk.' },
      ],
      modules: [],
      conversations: { templateAgent: 'trunk', ...conversations } as never,
    });
  }

  it('rejects an unknown template agent at creation', async () => {
    await assert.rejects(
      () => AgentFramework.create({
        storePath: join(tempDir, 'test.chronicle'),
        membrane: membrane.asMembrane(),
        agents: [{ name: 'trunk', model: 'test-model', systemPrompt: 'x' }],
        modules: [],
        conversations: { templateAgent: 'nope' },
      }),
      /templateAgent "nope"/,
    );
  });

  it('DM message spawns a fork, routes the message there, and triggers inference', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi alice!' }]));
    const framework = await makeFramework();

    framework.pushEvent(incomingEvent({
      channelId: 'slack:D1', text: 'hello there', channelType: 'im',
    }));
    await framework.runUntilIdle();

    const fork = framework.getAgent('conversation-slack-D1-g1');
    assert.ok(fork, 'fork agent should exist');

    // Message landed in the fork's context, not the trunk's.
    const { messages: forkMessages } = await fork!.getContextManager().compile();
    assert.ok(
      forkMessages.some((m) => JSON.stringify(m.content).includes('hello there')),
      'fork context should contain the incoming message',
    );
    const trunk = framework.getAgent('trunk')!;
    const { messages: trunkMessages } = await trunk.getContextManager().compile();
    assert.ok(
      !trunkMessages.some((m) => JSON.stringify(m.content).includes('hello there')),
      'trunk context must not receive routed messages',
    );

    // Inference ran for the fork.
    assert.ok(membrane.calls.length >= 1, 'inference should have been triggered');

    // Binding is live.
    const router = framework.getConversationRouter()!;
    assert.equal(router.getBinding('slack:D1')?.agentName, 'conversation-slack-D1-g1');

    await framework.stop();
  });

  it('channel message without mention is dropped; mention spawns', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'On it.' }]));
    const framework = await makeFramework();

    framework.pushEvent(incomingEvent({ channelId: 'slack:C1', text: 'just chatting' }));
    await framework.runUntilIdle();
    assert.equal(framework.getAgent('conversation-slack-C1-g1'), null, 'no fork without mention');
    assert.equal(membrane.calls.length, 0, 'no inference for unrouted messages');

    framework.pushEvent(incomingEvent({ channelId: 'slack:C1', text: 'bot, help', mentioned: true }));
    await framework.runUntilIdle();
    assert.ok(framework.getAgent('conversation-slack-C1-g1'), 'mention spawns fork');

    await framework.stop();
  });

  it('non-mention on a bound channel lands in context without triggering', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ack' }]));
    const framework = await makeFramework();

    framework.pushEvent(incomingEvent({ channelId: 'slack:C1', text: 'first', mentioned: true }));
    await framework.runUntilIdle();
    const callsAfterSpawn = membrane.calls.length;

    framework.pushEvent(incomingEvent({ channelId: 'slack:C1', text: 'ambient detail' }));
    await framework.runUntilIdle();

    const fork = framework.getAgent('conversation-slack-C1-g1')!;
    const { messages } = await fork.getContextManager().compile();
    assert.ok(
      messages.some((m) => JSON.stringify(m.content).includes('ambient detail')),
      'ambient message should land in fork context',
    );
    assert.equal(membrane.calls.length, callsAfterSpawn, 'ambient message must not trigger inference');

    await framework.stop();
  });

  it('fork inherits the template context', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
    const framework = await makeFramework();

    // Seed the trunk (primary agent) with handbook-like content.
    framework.getAgent('trunk')!.getContextManager().addMessage('user', [
      { type: 'text', text: 'HANDBOOK: always check the logs first.' },
    ]);

    framework.pushEvent(incomingEvent({ channelId: 'slack:D2', text: 'hi', channelType: 'im' }));
    await framework.runUntilIdle();

    const fork = framework.getAgent('conversation-slack-D2-g1')!;
    const { messages } = await fork.getContextManager().compile();
    assert.ok(
      messages.some((m) => JSON.stringify(m.content).includes('HANDBOOK')),
      'fork should inherit trunk context',
    );

    await framework.stop();
  });

  it('idle TTL runs a closure turn, unbinds, and the next message spawns g2', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello!' }]));
    const framework = await makeFramework({ idleTtlMs: 1 });

    framework.pushEvent(incomingEvent({ channelId: 'slack:D3', text: 'hi', channelType: 'im' }));
    await framework.runUntilIdle();
    const router = framework.getConversationRouter()!;
    assert.ok(router.getBinding('slack:D3'));

    // Let the TTL elapse, re-arm the sweep throttle, and provide the
    // closure-turn response.
    await new Promise((r) => setTimeout(r, 5));
    (framework as unknown as { lastConversationSweep: number }).lastConversationSweep = 0;
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Final report posted.' }]));

    // Nudge the loop so the sweep runs.
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'tick', metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();

    assert.equal(router.getBinding('slack:D3'), undefined, 'binding should be gone after TTL');
    const g1 = framework.getAgent('conversation-slack-D3-g1')!;
    const { messages } = await g1.getContextManager().compile();
    assert.ok(
      messages.some((m) => JSON.stringify(m.content).includes('engagement is closing')),
      'closure prompt should be in the fork context',
    );

    // Next DM spawns a fresh generation.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi again' }]));
    framework.pushEvent(incomingEvent({ channelId: 'slack:D3', text: 'back again', channelType: 'im' }));
    await framework.runUntilIdle();
    assert.ok(framework.getAgent('conversation-slack-D3-g2'), 'rebind spawns generation 2');

    await framework.stop();
  });
});
