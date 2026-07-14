import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agent.js';
import type { AgentConfig } from '../src/types/agent.js';
import type { ContextManager } from '@animalabs/context-manager';
import type { Membrane } from '@animalabs/membrane';

/** buildActivationRequest only needs compile(); membrane is never touched. */
const stubContextManager = {
  compile: async () => ({ messages: [], systemInjections: [] }),
} as unknown as ContextManager;

function createAgent(config: Partial<AgentConfig>): Agent {
  return new Agent(
    { name: 'tester', model: 'test-model', systemPrompt: 'sys', ...config },
    stubContextManager,
    {} as Membrane,
  );
}

describe('Agent cacheTtl forwarding', () => {
  it('forwards cacheTtl on the activation request when configured', async () => {
    const agent = createAgent({ cacheTtl: '1h' });
    const request = await agent.buildActivationRequest([]);
    assert.equal(request.promptCaching, true);
    assert.equal(request.cacheTtl, '1h');
  });

  it('defaults cacheTtl to 1h when unset', async () => {
    const agent = createAgent({});
    const request = await agent.buildActivationRequest([]);
    assert.equal(request.promptCaching, true);
    assert.equal(request.cacheTtl, '1h');
  });

  it('preserves an explicit 5m override', async () => {
    const agent = createAgent({ cacheTtl: '5m' });
    const request = await agent.buildActivationRequest([]);
    assert.equal(request.cacheTtl, '5m');
  });
});

describe('Agent provider parameter forwarding', () => {
  it('forwards stateless Responses reasoning and compaction settings unchanged', async () => {
    const providerParams = {
      reasoning: { effort: 'high', context: 'all_turns' },
      context_management: [{ type: 'compaction', compact_threshold: 850000 }],
    };
    const agent = createAgent({ providerParams });
    const request = await agent.buildActivationRequest([]);
    assert.deepEqual(request.providerParams, providerParams);
  });
});
