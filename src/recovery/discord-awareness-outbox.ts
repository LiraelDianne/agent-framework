import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_DISCORD_AWARENESS_EMOJI = '💤';

export function defaultDiscordAwarenessOutboxPath(storePath: string): string {
  return join(storePath, 'recovery', 'discord-awareness-outbox.json');
}

export interface DiscordAwarenessRef {
  serverId: string;
  channelId: string;
  messageId: string;
}

export interface DiscordAwarenessBatch {
  id: string;
  status: 'prepared' | 'pending';
  agentName: string;
  sourceBranch: string;
  targetBranch: string;
  emoji: string;
  createdAt: number;
  refs: DiscordAwarenessRef[];
  /**
   * `target-branch` is safe to promote when that branch is active because the
   * branch point itself removed the refs. `explicit` means a second mutation
   * (such as branch-local suppression) must finish before activate().
   */
  activationPolicy?: 'target-branch' | 'explicit';
}

interface DiscordAwarenessOutboxDocument {
  version: 1;
  batches: DiscordAwarenessBatch[];
}

export interface DiscordMessageMetadataCarrier {
  metadata?: Record<string, unknown>;
}

/**
 * Extract only Discord addressing metadata from messages. Message content is
 * deliberately ignored: recovery tooling must never need to compile or send a
 * quarantined message to an inference API merely to mark it on Discord.
 *
 * `forcedServerId` is useful for old stores that predate `metadata.serverId`.
 */
export function extractDiscordAwarenessRefs(
  messages: DiscordMessageMetadataCarrier[],
  forcedServerId?: string,
): DiscordAwarenessRef[] {
  const refs = new Map<string, DiscordAwarenessRef>();

  for (const message of messages) {
    const metadata = message.metadata ?? {};
    const channelId = typeof metadata.channelId === 'string' ? metadata.channelId : '';
    const messageId = typeof metadata.messageId === 'string' ? metadata.messageId : '';
    const metadataServerId = typeof metadata.serverId === 'string' ? metadata.serverId : '';
    const serverId = forcedServerId ?? metadataServerId;
    if (!channelId || !messageId || !serverId) continue;

    // Portal and other surfaces can use messageId/channelId too. Only enqueue
    // direct Discord surface records; they are the ones whose server exposes
    // Discord's add_reaction tool and whose bot identity owns the marker.
    const isDiscord = serverId.toLowerCase().includes('discord') || channelId.startsWith('discord:');
    if (!isDiscord) continue;

    const ref = { serverId, channelId, messageId };
    refs.set(`${serverId}\0${channelId}\0${messageId}`, ref);
  }

  return [...refs.values()];
}

/**
 * A filesystem outbox adjacent to (but outside) Chronicle branch state.
 *
 * Batches are written as `prepared` before a branch switch, then promoted to
 * `pending` after the safe branch becomes active. On startup, a prepared batch
 * whose target is already the active branch is promoted automatically. This
 * closes the crash window between the Chronicle switch and the outbox commit.
 */
export class DiscordAwarenessOutbox {
  constructor(readonly path: string) {}

  prepare(input: {
    agentName: string;
    sourceBranch: string;
    targetBranch: string;
    refs: DiscordAwarenessRef[];
    emoji?: string;
    activationPolicy?: 'target-branch' | 'explicit';
  }): DiscordAwarenessBatch | null {
    const refs = dedupeRefs(input.refs);
    if (refs.length === 0) return null;

    const document = this.read();
    const batch: DiscordAwarenessBatch = {
      id: randomUUID(),
      status: 'prepared',
      agentName: input.agentName,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      emoji: input.emoji ?? DEFAULT_DISCORD_AWARENESS_EMOJI,
      createdAt: Date.now(),
      refs,
      activationPolicy: input.activationPolicy ?? 'target-branch',
    };
    document.batches.push(batch);
    this.write(document);
    return batch;
  }

  activate(batchId: string): void {
    const document = this.read();
    const batch = document.batches.find((candidate) => candidate.id === batchId);
    if (!batch) throw new Error(`Discord awareness outbox batch not found: ${batchId}`);
    if (batch.status === 'pending') return;
    batch.status = 'pending';
    this.write(document);
  }

  /** Recover a crash after Chronicle switched branches but before activate(). */
  activatePreparedForBranch(branchName: string): number {
    const document = this.read();
    let activated = 0;
    for (const batch of document.batches) {
      if (
        batch.status === 'prepared'
        && batch.targetBranch === branchName
        && (batch.activationPolicy ?? 'target-branch') === 'target-branch'
      ) {
        batch.status = 'pending';
        activated++;
      }
    }
    if (activated > 0) this.write(document);
    return activated;
  }

  pending(serverId?: string): DiscordAwarenessBatch[] {
    return this.read().batches
      .filter((batch) => batch.status === 'pending')
      .map((batch) => ({
        ...batch,
        refs: batch.refs.filter((ref) => serverId === undefined || ref.serverId === serverId),
      }))
      .filter((batch) => batch.refs.length > 0);
  }

  acknowledge(batchId: string, ref: DiscordAwarenessRef): void {
    const document = this.read();
    const batch = document.batches.find((candidate) => candidate.id === batchId);
    if (!batch) return; // Already fully acknowledged by another idempotent drain.
    batch.refs = batch.refs.filter((candidate) => !sameRef(candidate, ref));
    if (batch.refs.length === 0) {
      document.batches = document.batches.filter((candidate) => candidate.id !== batchId);
    }
    this.write(document);
  }

  private read(): DiscordAwarenessOutboxDocument {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, batches: [] };
      }
      throw new Error(
        `Could not read Discord awareness outbox ${this.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!isDocument(parsed)) {
      throw new Error(`Invalid Discord awareness outbox document: ${this.path}`);
    }
    return parsed;
  }

  private write(document: DiscordAwarenessOutboxDocument): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

function dedupeRefs(refs: DiscordAwarenessRef[]): DiscordAwarenessRef[] {
  const deduped = new Map<string, DiscordAwarenessRef>();
  for (const ref of refs) {
    if (!ref.serverId || !ref.channelId || !ref.messageId) continue;
    deduped.set(`${ref.serverId}\0${ref.channelId}\0${ref.messageId}`, { ...ref });
  }
  return [...deduped.values()];
}

function sameRef(a: DiscordAwarenessRef, b: DiscordAwarenessRef): boolean {
  return a.serverId === b.serverId && a.channelId === b.channelId && a.messageId === b.messageId;
}

function isDocument(value: unknown): value is DiscordAwarenessOutboxDocument {
  if (!value || typeof value !== 'object') return false;
  const document = value as { version?: unknown; batches?: unknown };
  if (document.version !== 1 || !Array.isArray(document.batches)) return false;
  return document.batches.every((batch) => {
    if (!batch || typeof batch !== 'object') return false;
    const candidate = batch as Partial<DiscordAwarenessBatch>;
    return typeof candidate.id === 'string'
      && (candidate.status === 'prepared' || candidate.status === 'pending')
      && typeof candidate.agentName === 'string'
      && typeof candidate.sourceBranch === 'string'
      && typeof candidate.targetBranch === 'string'
      && typeof candidate.emoji === 'string'
      && typeof candidate.createdAt === 'number'
      && Array.isArray(candidate.refs)
      && (candidate.activationPolicy === undefined
        || candidate.activationPolicy === 'target-branch'
        || candidate.activationPolicy === 'explicit')
      && candidate.refs.every((ref) => !!ref
        && typeof ref.serverId === 'string'
        && typeof ref.channelId === 'string'
        && typeof ref.messageId === 'string');
  });
}
