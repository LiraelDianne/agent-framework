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

  it('omits cacheTtl entirely when unset, leaving the provider default', async () => {
    const agent = createAgent({});
    const request = await agent.buildActivationRequest([]);
    assert.equal(request.promptCaching, true);
    assert.equal('cacheTtl' in request, false);
  });
});
