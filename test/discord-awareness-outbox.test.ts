import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DiscordAwarenessOutbox,
  extractDiscordAwarenessRefs,
} from '../src/recovery/discord-awareness-outbox.js';
import { AgentFramework } from '../src/framework.js';

test('extractDiscordAwarenessRefs keeps only direct Discord addressing metadata', () => {
  const refs = extractDiscordAwarenessRefs([
    { metadata: { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' } },
    { metadata: { serverId: 'portal', channelId: 'portal:thread-1', messageId: 'p1' } },
    { metadata: { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' } },
    { metadata: { serverId: 'discord', channelId: 'discord:g1:c1' } },
  ]);

  assert.deepEqual(refs, [
    { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' },
  ]);
});

test('prepared batches survive restart, activate by branch, and acknowledge per ref', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-awareness-outbox-'));
  const path = join(dir, 'outbox.json');
  try {
    const first = new DiscordAwarenessOutbox(path);
    const batch = first.prepare({
      agentName: 'cairn',
      sourceBranch: 'main',
      targetBranch: 'recovery/cairn/1',
      refs: [
        { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' },
        { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm2' },
      ],
    });
    assert.ok(batch);
    assert.equal(first.pending('discord').length, 0, 'prepared work is not delivered early');

    // Simulate the host restarting after Chronicle switched branches but
    // before the recovery process activated its batch.
    const reopened = new DiscordAwarenessOutbox(path);
    assert.equal(reopened.activatePreparedForBranch('some-other-branch'), 0);
    assert.equal(reopened.activatePreparedForBranch('recovery/cairn/1'), 1);
    assert.equal(reopened.pending('discord')[0].refs.length, 2);

    reopened.acknowledge(batch.id, batch.refs[0]);
    assert.deepEqual(reopened.pending('discord')[0].refs.map((ref) => ref.messageId), ['m2']);
    reopened.acknowledge(batch.id, batch.refs[1]);
    assert.equal(reopened.pending('discord').length, 0);

    const stored = JSON.parse(readFileSync(path, 'utf8')) as { batches: unknown[] };
    assert.deepEqual(stored.batches, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit batches are not activated merely because their target branch is current', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-awareness-explicit-'));
  const path = join(dir, 'outbox.json');
  try {
    const outbox = new DiscordAwarenessOutbox(path);
    const batch = outbox.prepare({
      agentName: 'cairn',
      sourceBranch: 'main',
      targetBranch: 'recovery/cairn/suppressed',
      activationPolicy: 'explicit',
      refs: [
        { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' },
      ],
    })!;

    assert.equal(outbox.activatePreparedForBranch('recovery/cairn/suppressed'), 0);
    assert.equal(outbox.pending('discord').length, 0);
    outbox.activate(batch.id);
    assert.equal(outbox.pending('discord').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('framework drain sends raw Discord addresses and retains failed work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-awareness-drain-'));
  const path = join(dir, 'outbox.json');
  try {
    const outbox = new DiscordAwarenessOutbox(path);
    const batch = outbox.prepare({
      agentName: 'cairn',
      sourceBranch: 'main',
      targetBranch: 'recovery/cairn/2',
      refs: [
        { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' },
        { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm2' },
      ],
    })!;
    outbox.activate(batch.id);

    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let failSecond = true;
    const connection = {
      isConnected: true,
      sendToolsCall: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (args.messageId === 'm2' && failSecond) throw new Error('Discord unavailable');
        return { content: [{ type: 'text', text: 'Reaction added' }] };
      },
    };
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.discordAwarenessOutbox = outbox;
    framework.discordAwarenessDrains = new Map();
    framework.mcplServerRegistry = { getServer: () => connection };

    const originalError = console.error;
    console.error = () => {};
    try {
      await framework.drainDiscordAwarenessOutbox('discord');
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(calls[0], {
      name: 'add_reaction',
      args: { channelId: 'c1', messageId: 'm1', emoji: '💤' },
    });
    assert.deepEqual(outbox.pending('discord')[0].refs.map((ref) => ref.messageId), ['m2']);

    failSecond = false;
    await framework.drainDiscordAwarenessOutbox('discord');
    assert.equal(outbox.pending('discord').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('message-granular undo prepares markers before switching branches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-awareness-undo-'));
  const path = join(dir, 'outbox.json');
  try {
    const messages = [
      { id: 'i0', metadata: { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm0' } },
      { id: 'i1', metadata: { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' } },
      { id: 'i2', metadata: { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm2' } },
    ];
    const calls: string[] = [];
    const contextManager = {
      getAllMessages: () => messages,
      branchAt: (_id: string, name: string) => { calls.push(`branch:${name}`); return name; },
      switchBranch: async (name: string) => { calls.push(`switch:${name}`); },
    };
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.agents = new Map([['cairn', {
      state: { status: 'idle' },
      getContextManager: () => contextManager,
    }]]);
    framework.store = { currentBranch: () => ({ name: 'main' }) };
    framework.discordAwarenessOutbox = new DiscordAwarenessOutbox(path);
    framework.discordAwarenessDrains = new Map();
    framework.mcplServerRegistry = null;
    framework.moduleRegistry = { getModule: () => null };
    framework.lastVisiblePreview = async () => null;

    const result = await framework.handleHostCommand('discord', {
      command: 'undo', agentName: 'cairn', messages: 2,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.removedRefs.map((ref: { messageId: string }) => ref.messageId), ['m1', 'm2']);
    assert.deepEqual(calls.map((call) => call.split('/')[0]), ['branch:undo-msgs', 'switch:undo-msgs']);
    assert.deepEqual(
      framework.discordAwarenessOutbox.pending('discord')[0].refs.map((ref: { messageId: string }) => ref.messageId),
      ['m1', 'm2'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
