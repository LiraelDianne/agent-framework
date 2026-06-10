/**
 * ConversationRouter — routes incoming channel messages to per-channel
 * conversation agents ("forks") instead of the primary conversation.
 *
 * The router is a lookup table plus policy — deliberately no LLM in the
 * routing path. The framework consults it from handleMcplChannelIncoming:
 *
 * - A channel with an active binding routes to its bound agent. Whether the
 *   message *triggers* inference (vs. just landing in the fork's context) is
 *   a separate per-channel-kind rule: in a busy channel everything is case
 *   input but only mentions demand a reply.
 * - An unbound channel binds (→ the framework spawns a fork from the
 *   template/trunk agent) when the bind rule matches: by default any message
 *   in a DM, an explicit bot mention in a channel (`metadata.mentioned`,
 *   set server-side by the platform adapters).
 * - Everything else is left unrouted and dropped by the framework — the
 *   trunk is a dormant template, not a listener.
 *
 * Bindings expire after an idle TTL. Expiry runs a final closure turn on the
 * fork (see framework wiring) and unbinds; the next qualifying message on
 * that channel spawns a *fresh* fork (generation + 1) from the current
 * trunk, so handbook/template updates propagate between engagements.
 *
 * The binding table is in-memory. Fork agent context lives in Chronicle
 * under its own namespace and survives restarts; bindings themselves are
 * re-established by the next qualifying message.
 */

import type { ContextStrategy } from '@animalabs/context-manager';
import type { ChannelDescriptor } from './types.js';

// ============================================================================
// Config & types
// ============================================================================

/** When an unbound channel acquires a fork. */
export type BindRule = 'always' | 'mention' | 'never';

/** When a message on a bound channel triggers inference (it always lands in
 * the fork's context). */
export type TriggerRule = 'always' | 'mention';

export interface ConversationRouterConfig {
  /** Agent whose context seeds new forks (the "trunk"/warm checkpoint). */
  templateAgent: string;

  /** Bind rules per channel kind. Defaults: dm 'always', channel 'mention'. */
  bind?: { dm?: BindRule; channel?: BindRule };

  /** Trigger rules per channel kind. Defaults: dm 'always', channel 'mention'. */
  trigger?: { dm?: TriggerRule; channel?: TriggerRule };

  /** Idle time before a binding expires and the fork is closed. Default 12h. */
  idleTtlMs?: number;

  /** Final system-initiated user message sent to a fork on expiry. */
  closurePrompt?: string;

  /** Prefix for generated fork agent names. Default 'conversation'. */
  agentPrefix?: string;

  /**
   * Fresh compression strategy per fork. Strategy instances are stateful and
   * must not be shared between ContextManagers, so the template agent's own
   * strategy is never reused — without a factory, forks get passthrough.
   */
  strategyFactory?: () => ContextStrategy;
}

export interface ConversationBinding {
  channelId: string;
  agentName: string;
  /** Engagement counter per channel — fresh forks get a new generation. */
  generation: number;
  boundAt: number;
  lastActivity: number;
}

/** The facts route() needs about one incoming message, pre-extracted by the
 * framework so the router stays free of event-shape knowledge. */
export interface IncomingMessageFacts {
  channelId: string;
  /** Personal mention of the bot (metadata.mentioned from the adapter). */
  mentioned: boolean;
  /** DM or group-DM channel (see isDmChannel). */
  isDm: boolean;
  /** Clock injection for tests; defaults to Date.now(). */
  now?: number;
}

export type RoutingDecision =
  /** Channel already has a fork — deliver there. */
  | { kind: 'existing'; agentName: string; trigger: boolean }
  /** Bind rule matched — framework should spawn this agent, then bind(). */
  | { kind: 'spawn'; agentName: string; generation: number; trigger: boolean }
  /** No binding and bind rule didn't match — drop. */
  | { kind: 'unbound' };

const DEFAULT_IDLE_TTL_MS = 12 * 60 * 60 * 1000;

export const DEFAULT_CLOSURE_PROMPT =
  '[system] This engagement is closing due to inactivity. Finalize your ' +
  'work: post any promised results to the channel and record outstanding ' +
  'threads as unresolved. Do not ask follow-up questions.';

// ============================================================================
// ConversationRouter
// ============================================================================

export class ConversationRouter {
  private config: ConversationRouterConfig;

  /** Active bindings, keyed by channelId. */
  private bindings = new Map<string, ConversationBinding>();

  /** Engagement counter per channel — survives unbind, so a re-bound channel
   * gets a distinct fork agent name. */
  private generations = new Map<string, number>();

  constructor(config: ConversationRouterConfig) {
    this.config = config;
  }

  get templateAgent(): string {
    return this.config.templateAgent;
  }

  get closurePrompt(): string {
    return this.config.closurePrompt ?? DEFAULT_CLOSURE_PROMPT;
  }

  get idleTtlMs(): number {
    return this.config.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  }

  get strategyFactory(): (() => ContextStrategy) | undefined {
    return this.config.strategyFactory;
  }

  /**
   * Decide where an incoming message goes. Pure read except for refreshing
   * lastActivity on an existing binding — a 'spawn' decision does NOT create
   * the binding; the framework calls bind() after the fork agent actually
   * exists, so a failed spawn doesn't leave a dangling route.
   */
  route(facts: IncomingMessageFacts): RoutingDecision {
    const now = facts.now ?? Date.now();
    const existing = this.bindings.get(facts.channelId);

    if (existing) {
      existing.lastActivity = now;
      return {
        kind: 'existing',
        agentName: existing.agentName,
        trigger: this.shouldTrigger(facts),
      };
    }

    const bindRule = facts.isDm
      ? (this.config.bind?.dm ?? 'always')
      : (this.config.bind?.channel ?? 'mention');

    const binds =
      bindRule === 'always' || (bindRule === 'mention' && facts.mentioned);
    if (!binds) {
      return { kind: 'unbound' };
    }

    const generation = (this.generations.get(facts.channelId) ?? 0) + 1;
    return {
      kind: 'spawn',
      agentName: this.forkAgentName(facts.channelId, generation),
      generation,
      trigger: this.shouldTrigger(facts),
    };
  }

  /**
   * Record a binding after the framework successfully spawned the fork.
   * Returns the new binding.
   */
  bind(channelId: string, agentName: string, generation: number, now = Date.now()): ConversationBinding {
    this.generations.set(channelId, generation);
    const binding: ConversationBinding = {
      channelId,
      agentName,
      generation,
      boundAt: now,
      lastActivity: now,
    };
    this.bindings.set(channelId, binding);
    return binding;
  }

  unbind(channelId: string): void {
    this.bindings.delete(channelId);
  }

  getBinding(channelId: string): ConversationBinding | undefined {
    return this.bindings.get(channelId);
  }

  /** Reverse lookup: the channel an agent is bound to, if any. */
  channelForAgent(agentName: string): string | undefined {
    for (const binding of this.bindings.values()) {
      if (binding.agentName === agentName) return binding.channelId;
    }
    return undefined;
  }

  getBindings(): ConversationBinding[] {
    return Array.from(this.bindings.values());
  }

  /** Bindings whose idle TTL has elapsed. Does not unbind — the framework
   * runs the closure turn first, then calls unbind(). */
  expired(now = Date.now()): ConversationBinding[] {
    const ttl = this.idleTtlMs;
    return this.getBindings().filter((b) => now - b.lastActivity >= ttl);
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * Classify a channel as DM-like from its descriptor and/or message
   * metadata. Slack marks DMs/group DMs with is_im/is_mpim on the channel
   * descriptor and channel_type on each message; other platforms can adopt
   * either convention.
   */
  static isDmChannel(
    descriptor?: ChannelDescriptor,
    messageMetadata?: Record<string, unknown>,
  ): boolean {
    const meta = descriptor?.metadata as Record<string, unknown> | undefined;
    if (meta?.is_im === true || meta?.is_mpim === true) return true;
    const channelType = messageMetadata?.channel_type;
    return channelType === 'im' || channelType === 'mpim';
  }

  private shouldTrigger(facts: IncomingMessageFacts): boolean {
    const rule = facts.isDm
      ? (this.config.trigger?.dm ?? 'always')
      : (this.config.trigger?.channel ?? 'mention');
    return rule === 'always' || facts.mentioned;
  }

  /** `conversation-slack-C123-g2` — agent names double as Chronicle
   * namespace components, so the channel id is sanitized. */
  private forkAgentName(channelId: string, generation: number): string {
    const prefix = this.config.agentPrefix ?? 'conversation';
    const safe = channelId.replace(/[^A-Za-z0-9_-]+/g, '-');
    return `${prefix}-${safe}-g${generation}`;
  }
}
