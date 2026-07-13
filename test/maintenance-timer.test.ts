import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ContextEntry,
  ContextLogView,
  ContextStrategy,
  MessageStoreView,
  ReadinessState,
  StrategyContext,
  TokenBudget,
} from '@animalabs/context-manager';
import type {
  Module,
  ModuleContext,
  EventResponse,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import type { NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';

class QueuedStrategy implements ContextStrategy {
  readonly name = 'queued-test';
  ticks = 0;
  toolCounts: number[] = [];

  checkReadiness(): ReadinessState {
    return { ready: this.ticks >= 2, description: 'test maintenance queued' };
  }

  async tick(ctx: StrategyContext): Promise<void> {
    this.toolCounts.push(ctx.tools?.length ?? 0);
    this.ticks++;
  }

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

class ToolModule implements Module {
  readonly name = 'maintenance-tools';

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [{
      name: 'inspect',
      description: 'test tool',
      inputSchema: { type: 'object', properties: {} },
    }];
  }

  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    return { success: false, error: 'not expected', isError: true };
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }
}

const membrane = {
  async complete(_request: NormalizedRequest): Promise<NormalizedResponse> {
    throw new Error('not expected');
  },
} as unknown as import('@animalabs/membrane').Membrane;

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for maintenance');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('queued context maintenance timer', () => {
  it('drains without a new message and refreshes tools before ticking', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-'));
    const strategy = new QueuedStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{
        name: 'agent',
        model: 'test-model',
        systemPrompt: 'test',
        strategy,
        allowedTools: 'all',
      }],
      modules: [new ToolModule()],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });

    try {
      framework.start();
      await waitFor(() => strategy.ticks >= 2);
      assert.deepEqual(strategy.toolCounts, [1, 1]);
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.length === 1);
      const snapshot = framework.getContextMaintenanceSnapshot();
      assert.equal(snapshot.current, null);
      assert.equal(snapshot.history[0].agents[0].ticks, 2);
      assert.equal(snapshot.history[0].agents[0].readyAfter, true);
      assert.deepEqual(snapshot.agents, [{ agentName: 'agent', ready: true }]);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can be disabled explicitly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-disabled-'));
    const strategy = new QueuedStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{
        name: 'agent',
        model: 'test-model',
        systemPrompt: 'test',
        strategy,
      }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });

    try {
      framework.start();
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.equal(strategy.ticks, 0);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
