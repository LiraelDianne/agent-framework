import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentFramework } from '../src/framework.js';

/**
 * rewindTriggeringTurn is the shared core of the refusal auto-rewind: it
 * redacts the newest non-agent turn (a tool result or an ingested message) and
 * injects a metadata-only marker in its place. It's private and the full
 * framework is heavy, so we exercise it on a prototype instance with a
 * minimal in-memory ContextManager stub (removeMessage / addMessage /
 * getAllMessages), mirroring inference-failure-observability.test.ts.
 */
function makeAgentHarness(messages: any[]) {
  const removed: string[] = [];
  const added: Array<{ participant: string; content: any[]; meta: any }> = [];
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
  };
  const fw = Object.create(AgentFramework.prototype) as any;
  const agent = { name: 'labclaude', getContextManager: () => cm };
  return { fw, agent, removed, added, messages };
}

test('rewind: tool result → redacted + content-free marker', () => {
  const msgs = [
    { id: 'm1', participant: 'simulect', content: [{ type: 'text', text: 'help me shop' }], metadata: { messageId: '111', channelId: 'discord:g:c' } },
    { id: 'm2', participant: 'labclaude', content: [{ type: 'text', text: 'on it' }, { type: 'tool_use', name: 'shell' }] },
    { id: 'm3', participant: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'X'.repeat(320 * 1024) }] },
  ];
  const { fw, agent, removed, added } = makeAgentHarness(msgs);

  const rec = fw.rewindTriggeringTurn(agent, 'cyber');
  assert.ok(rec, 'should return a record');
  assert.equal(rec.kind, 'tool');
  assert.equal(removed[0], 'm3', 'redacts the tool result, not the agent turn');
  assert.match(rec.descriptor, /tool result/);
  assert.match(rec.descriptor, /320KB/);

  // Marker is injected, tagged, and carries NONE of the offending content.
  assert.equal(added.length, 1);
  assert.equal(added[0].meta.kind, 'refusal-rewind');
  assert.equal(added[0].meta.category, 'cyber');
  assert.ok(!added[0].content[0].text.includes('XXXX'), 'marker must not echo the withheld content');
  assert.match(added[0].content[0].text, /\[refusal-rewind\]/);
});

test('rewind: human message → kind=human + discordRef for announce', () => {
  const msgs = [
    { id: 'm1', participant: 'labclaude', content: [{ type: 'text', text: 'hi' }] },
    { id: 'm2', participant: 'simulect', content: [{ type: 'text', text: 'sketchy paste' }], metadata: { messageId: '999', channelId: 'discord:g:c' } },
  ];
  const { fw, agent, removed } = makeAgentHarness(msgs);

  const rec = fw.rewindTriggeringTurn(agent, 'cyber');
  assert.ok(rec);
  assert.equal(rec.kind, 'human');
  assert.equal(removed[0], 'm2');
  assert.deepEqual(rec.discordRef, { channelId: 'discord:g:c', messageId: '999' });
});

test('rewind: never rewinds a prior system marker (no backward chewing)', () => {
  const msgs = [
    { id: 'm1', participant: 'simulect', content: [{ type: 'text', text: 'real msg' }], metadata: { messageId: '1' } },
    { id: 'm2', participant: 'user', content: [{ type: 'text', text: '[refusal-rewind] ...' }], metadata: { system: true, kind: 'refusal-rewind' } },
  ];
  const { fw, agent, removed } = makeAgentHarness(msgs);

  const rec = fw.rewindTriggeringTurn(agent, 'cyber');
  assert.equal(rec, null, 'a system marker at the tail is not eligible');
  assert.equal(removed.length, 0);
});

test('rewind: nothing eligible when only agent turns remain', () => {
  const msgs = [
    { id: 'm1', participant: 'labclaude', content: [{ type: 'text', text: 'a' }] },
    { id: 'm2', participant: 'labclaude', content: [{ type: 'text', text: 'b' }] },
  ];
  const { fw, agent } = makeAgentHarness(msgs);
  assert.equal(fw.rewindTriggeringTurn(agent, 'cyber'), null);
});
