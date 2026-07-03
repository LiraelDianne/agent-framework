import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentFramework } from '../src/framework.js';

/**
 * The refusal auto-rewind sheds the newest real turn (in sequence, newest
 * first) and maintains exactly ONE consolidated marker per episode. These
 * exercise the two private primitives on a prototype instance with a minimal
 * in-memory ContextManager stub, mirroring inference-failure-observability.test.
 */
function makeAgentHarness(messages: any[]) {
  const removed: string[] = [];
  const added: Array<{ participant: string; content: any[]; meta: any }> = [];
  const edited: Array<{ id: string; content: any[] }> = [];
  const cm = {
    getAllMessages: () => messages,
    removeMessage: (id: string) => {
      removed.push(id);
      const i = messages.findIndex((m) => m.id === id);
      if (i >= 0) messages.splice(i, 1);
    },
    addMessage: (participant: string, content: any[], meta: any) => {
      const id = `marker-${added.length}`;
      added.push({ participant, content, meta });
      messages.push({ id, participant, content, metadata: meta });
      return id;
    },
    editMessage: (id: string, content: any[]) => {
      edited.push({ id, content });
      const m = messages.find((x) => x.id === id);
      if (m) m.content = content;
    },
  };
  const fw = Object.create(AgentFramework.prototype) as any;
  fw.rewindEpisode = new Map();
  const agent = { name: 'labclaude', getContextManager: () => cm };
  return { fw, agent, removed, added, edited, messages };
}

test('shed: removes the newest real turn (tool result) and adds NO marker itself', () => {
  const msgs = [
    { id: 'm1', participant: 'simulect', content: [{ type: 'text', text: 'help me shop' }], metadata: { messageId: '111', channelId: 'discord:g:c' } },
    { id: 'm2', participant: 'labclaude', content: [{ type: 'text', text: 'on it' }] },
    { id: 'm3', participant: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'X'.repeat(320 * 1024) }] },
  ];
  const { fw, agent, removed, added } = makeAgentHarness(msgs);

  const rec = fw.shedNewestTurn(agent);
  assert.ok(rec);
  assert.equal(rec.kind, 'tool');
  assert.equal(removed[0], 'm3', 'sheds the tool result, not the agent turn');
  assert.equal(added.length, 0, 'shedNewestTurn must not add a marker (caller owns the one marker)');
});

test('shed: human message → kind=human + discordRef', () => {
  const msgs = [
    { id: 'm1', participant: 'labclaude', content: [{ type: 'text', text: 'hi' }] },
    { id: 'm2', participant: 'simulect', content: [{ type: 'text', text: 'sketchy' }], metadata: { messageId: '999', channelId: 'discord:g:c' } },
  ];
  const { fw, agent, removed } = makeAgentHarness(msgs);
  const rec = fw.shedNewestTurn(agent);
  assert.equal(rec.kind, 'human');
  assert.equal(removed[0], 'm2');
  assert.deepEqual(rec.discordRef, { channelId: 'discord:g:c', messageId: '999' });
});

test('shed: skips the episode marker and sheds the real turn beneath it', () => {
  const msgs = [
    { id: 'm1', participant: 'simulect', content: [{ type: 'text', text: 'real msg' }], metadata: { messageId: '1' } },
    { id: 'mk', participant: 'user', content: [{ type: 'text', text: '[refusal-rewind] ...' }], metadata: { system: true, kind: 'refusal-rewind' } },
  ];
  const { fw, agent, removed } = makeAgentHarness(msgs);
  const rec = fw.shedNewestTurn(agent);
  assert.ok(rec, 'skips the marker, finds the real turn');
  assert.equal(removed[0], 'm1');
});

test('shed: null when only agent turns / markers remain', () => {
  const msgs = [
    { id: 'm1', participant: 'labclaude', content: [{ type: 'text', text: 'a' }] },
    { id: 'mk', participant: 'user', content: [{ type: 'text', text: 'x' }], metadata: { system: true } },
  ];
  const { fw, agent } = makeAgentHarness(msgs);
  assert.equal(fw.shedNewestTurn(agent), null);
});

test('marker: six rewinds produce ONE marker, updated in place (not six)', () => {
  const msgs = [{ id: 'm1', participant: 'labclaude', content: [{ type: 'text', text: 'a' }] }];
  const { fw, agent, added, edited } = makeAgentHarness(msgs);

  const c1 = fw.updateRewindMarker(agent, 'cyber');
  const c2 = fw.updateRewindMarker(agent, 'cyber');
  const c6 = (fw.updateRewindMarker(agent, 'cyber'), fw.updateRewindMarker(agent, 'cyber'),
              fw.updateRewindMarker(agent, 'cyber'), fw.updateRewindMarker(agent, 'cyber'));

  assert.equal(c1, 1);
  assert.equal(c2, 2);
  assert.equal(c6, 6);
  assert.equal(added.length, 1, 'exactly ONE marker message added for the whole episode');
  assert.equal(edited.length, 5, 'subsequent rewinds edit that one marker in place');
  assert.match(edited[edited.length - 1].content[0].text, /6 most recent turn/, 'marker reflects the running total');
  assert.equal(added[0].meta.kind, 'refusal-rewind');
});
