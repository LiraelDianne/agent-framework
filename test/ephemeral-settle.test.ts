import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { NormalizedRequest, YieldingStream } from '@animalabs/membrane';
import type {
  ErrorAction,
  ErrorPolicy,
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

class EphemeralToolModule implements Module {
  readonly name = 'test';
  readonly calls: ToolCall[] = [];

  constructor(private readonly endTurnTool = 'finish') {}

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'echo',
        description: 'Echo input',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
        },
      },
      {
        name: this.endTurnTool,
        description: 'Finish the turn',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    const baseName = call.name.includes('--')
      ? call.name.slice(call.name.lastIndexOf('--') + 2)
      : call.name;
    if (baseName === this.endTurnTool) {
      return { success: true, data: { finished: true }, endTurn: true };
    }
    return { success: true, data: { echoed: call.input } };
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }
}

class ThrowingMembrane extends MockMembrane {
  readonly errors: Error[];

  constructor(errors: Error[]) {
    super();
    this.errors = [...errors];
  }

  streamYielding(request: NormalizedRequest, _options?: unknown): YieldingStream {
    this.calls.push(request);
    throw this.errors.shift() ?? new Error('unexpected stream attempt');
  }
}

class RetryOncePolicy implements ErrorPolicy {
  maxRetries = 1;

  onInferenceError(_error: Error, _agentName: string, attempt: number): ErrorAction {
    if (attempt < this.maxRetries) {
      return { retry: true, delayMs: 0 };
    }
    return { retry: false };
  }
}

function tempStorePath(prefix: string): { tempDir: string; storePath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  return { tempDir, storePath: join(tempDir, 'store.chronicle') };
}

async function createEphemeral(
  framework: AgentFramework,
  name = 'worker',
) {
  const created = await framework.createEphemeralAgent({
    name,
    model: 'test-model',
    systemPrompt: 'Do the task.',
    allowedTools: 'all',
  });
  created.contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
  return created;
}

async function runStartedEphemeral(
  framework: AgentFramework,
  agent: Awaited<ReturnType<typeof createEphemeral>>['agent'],
  contextManager: Awaited<ReturnType<typeof createEphemeral>>['contextManager'],
) {
  const promise = framework.runEphemeralToCompletion(agent, contextManager);
  framework.start();
  return promise;
}

async function stopAndRemove(framework: AgentFramework, tempDir: string): Promise<void> {
  await framework.stop();
  rmSync(tempDir, { recursive: true, force: true });
}

describe('runEphemeralToCompletion settle signal', () => {
  it('resolves plain text completion and deregisters the agent', async () => {
    const { tempDir, storePath } = tempStorePath('ephemeral-plain-');
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Plain final answer' }]));

    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [new EphemeralToolModule()],
      syncIntervalMs: 0,
    });

    try {
      const { agent, contextManager } = await createEphemeral(framework);
      const result = await runStartedEphemeral(framework, agent, contextManager);

      assert.deepStrictEqual(result, {
        speech: 'Plain final answer',
        toolCallsCount: 0,
      });
      assert.strictEqual(framework.getAgent(agent.name), null);
    } finally {
      await stopAndRemove(framework, tempDir);
    }
  });

  it('resolves after tool rounds with final speech and dispatched call count', async () => {
    const { tempDir, storePath } = tempStorePath('ephemeral-tools-');
    const membrane = new MockMembrane();
    const tools = new EphemeralToolModule();

    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Using the first tool.' },
      { type: 'tool_use', id: 'call_1', name: 'test--echo', input: { message: 'one' } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Using the second tool.' },
      { type: 'tool_use', id: 'call_2', name: 'test--echo', input: { message: 'two' } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Post-tool final answer' },
    ]));

    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [tools],
      syncIntervalMs: 0,
    });

    try {
      const { agent, contextManager } = await createEphemeral(framework);
      const result = await runStartedEphemeral(framework, agent, contextManager);

      assert.deepStrictEqual(result, {
        speech: 'Post-tool final answer',
        toolCallsCount: 2,
      });
      assert.strictEqual(tools.calls.length, 2);
      assert.strictEqual(framework.getAgent(agent.name), null);
    } finally {
      await stopAndRemove(framework, tempDir);
    }
  });

  it('resolves through the endTurn tool-result path', async () => {
    const { tempDir, storePath } = tempStorePath('ephemeral-endturn-');
    const membrane = new MockMembrane();
    const tools = new EphemeralToolModule();

    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_finish', name: 'test--finish', input: {} },
    ], 'tool_use'));

    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [tools],
      syncIntervalMs: 0,
    });

    try {
      const { agent, contextManager } = await createEphemeral(framework);
      const result = await runStartedEphemeral(framework, agent, contextManager);

      assert.deepStrictEqual(result, {
        speech: '',
        toolCallsCount: 1,
      });
      assert.strictEqual(tools.calls.length, 1);
      assert.strictEqual(framework.getAgent(agent.name), null);
    } finally {
      await stopAndRemove(framework, tempDir);
    }
  });

  it('rejects only after error policy exhausts retries', async () => {
    const { tempDir, storePath } = tempStorePath('ephemeral-errors-');
    const membrane = new ThrowingMembrane([
      new Error('temporary failure'),
      new Error('final failure'),
    ]);

    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [new EphemeralToolModule()],
      errorPolicy: new RetryOncePolicy(),
      syncIntervalMs: 0,
    });

    try {
      const { agent, contextManager } = await createEphemeral(framework);
      const run = runStartedEphemeral(framework, agent, contextManager);

      await assert.rejects(run, /final failure/);
      assert.strictEqual(membrane.calls.length, 2, 'the retry attempt should run before settling');
      assert.strictEqual(framework.getAgent(agent.name), null);
    } finally {
      await stopAndRemove(framework, tempDir);
    }
  });

  it('does not register a trace listener for completion control flow', async () => {
    const { tempDir, storePath } = tempStorePath('ephemeral-trace-spy-');
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Trace independent' }]));

    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [new EphemeralToolModule()],
      syncIntervalMs: 0,
    });

    let onTraceCalls = 0;
    const originalOnTrace = framework.onTrace.bind(framework);
    framework.onTrace = ((listener: Parameters<typeof framework.onTrace>[0]) => {
      onTraceCalls++;
      return originalOnTrace(listener);
    }) as typeof framework.onTrace;

    try {
      const { agent, contextManager } = await createEphemeral(framework);
      const result = await runStartedEphemeral(framework, agent, contextManager);

      assert.strictEqual(result.speech, 'Trace independent');
      assert.strictEqual(onTraceCalls, 0);
      assert.strictEqual(framework.getAgent(agent.name), null);
    } finally {
      await stopAndRemove(framework, tempDir);
    }
  });

  it('startup watchdog rejects and deregisters when inference never starts', async () => {
    const { tempDir, storePath } = tempStorePath('ephemeral-startup-');
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [new EphemeralToolModule()],
      syncIntervalMs: 0,
    });

    const originalSetTimeout = globalThis.setTimeout;
    const originalSetInterval = globalThis.setInterval;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalClearInterval = globalThis.clearInterval;
    let startupCallback: (() => void) | null = null;

    globalThis.setTimeout = ((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ): ReturnType<typeof setTimeout> => {
      if (delay === 30_000 && typeof callback === 'function') {
        startupCallback = () => callback(...args);
      }
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.setInterval = ((
      _callback: (...args: unknown[]) => void,
      _delay?: number,
      ..._args: unknown[]
    ): ReturnType<typeof setInterval> => 2 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;
    globalThis.clearTimeout = ((_timeout?: ReturnType<typeof setTimeout>) => undefined) as typeof clearTimeout;
    globalThis.clearInterval = ((_interval?: ReturnType<typeof setInterval>) => undefined) as typeof clearInterval;

    try {
      const { agent, contextManager } = await createEphemeral(framework);
      const run = framework.runEphemeralToCompletion(agent, contextManager);
      const rejection = assert.rejects(run, /failed to start inference/);

      assert.ok(startupCallback, 'startup watchdog should be registered');
      (startupCallback as () => void)();

      await rejection;
      assert.strictEqual(framework.getAgent(agent.name), null);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearTimeout = originalClearTimeout;
      globalThis.clearInterval = originalClearInterval;
      await stopAndRemove(framework, tempDir);
    }
  });
});

describe('trace control-flow guard', () => {
  it('does not use this.onTrace inside src control flow', () => {
    const root = process.cwd();
    const srcRoot = join(root, 'src');
    const allowed = new Set([
      'src/framework.ts:onTrace: (listener) => this.onTrace(listener),',
    ]);
    const matches: string[] = [];

    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(path);
          continue;
        }
        if (!entry.isFile() || !path.endsWith('.ts')) continue;

        const rel = relative(root, path);
        const lines = readFileSync(path, 'utf8').split('\n');
        lines.forEach((line, index) => {
          if (!line.includes('this.onTrace(')) return;
          const key = `${rel}:${line.trim()}`;
          if (!allowed.has(key)) {
            matches.push(`${rel}:${index + 1}: ${line.trim()}`);
          }
        });
      }
    };

    visit(srcRoot);
    assert.deepStrictEqual(matches, []);
  });
});
