/**
 * LivenessWatchdog — detects a wedged (unresponsive) main thread and fails hard.
 *
 * The agent's event loop is single-threaded. A synchronous infinite loop or a
 * self-rescheduling microtask flood (e.g. a pathological compression drain) can
 * peg the thread for minutes: no events, no heartbeat, no recovery — the agent
 * goes silently deaf. A same-thread timer can't catch this (it can't fire while
 * the loop is blocked), so detection must live off-thread.
 *
 * Mechanism: the main thread stamps a heartbeat (and an optional phase label)
 * into shared memory on a timer. A worker thread — which keeps running even when
 * main is wedged — watches the heartbeat; if it goes stale past a threshold it
 * writes a diagnostic and kills the whole process:
 *   - 'abort' → SIGABRT (core dump if enabled, for an offline stack) then dies
 *   - 'exit'  → SIGKILL (clean, quiet; rely on the supervisor to restart)
 * Either way the supervisor (launchd/systemd) restarts a fresh process instead
 * of leaving a deaf one running.
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { phaseChannel } from '@animalabs/context-manager';

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'liveness-watchdog-worker.js');

const HEARTBEAT_OFFSET = 0; // Float64: last heartbeat (ms since epoch)
const PHASE_OFFSET = 16; // Uint8[48]: current phase label (UTF-8)
const PHASE_LEN = 48;
const SAB_SIZE = 64;

export interface WatchdogOptions {
  /** Wedge threshold: kill if no heartbeat for this long. Default 30000ms. */
  thresholdMs?: number;
  /** Heartbeat cadence. Default 1000ms. */
  heartbeatMs?: number;
  /** 'abort' → SIGABRT (core dump for debugging); 'exit' → SIGKILL. Default 'abort'. */
  action?: 'abort' | 'exit';
  /** Optional file the worker writes a JSON wedge report to before killing. */
  reportPath?: string;
  /** Disable entirely. */
  enabled?: boolean;
}

export class LivenessWatchdog {
  private readonly sab = new SharedArrayBuffer(SAB_SIZE);
  private readonly hb = new Float64Array(this.sab, HEARTBEAT_OFFSET, 1);
  private readonly phaseBuf = new Uint8Array(this.sab, PHASE_OFFSET, PHASE_LEN);
  private readonly enc = new TextEncoder();
  private timer?: ReturnType<typeof setInterval>;
  private worker?: Worker;
  private started = false;

  constructor(private readonly opts: WatchdogOptions = {}) {}

  start(): void {
    if (this.started || this.opts.enabled === false) return;
    this.started = true;
    const heartbeatMs = this.opts.heartbeatMs ?? 1000;
    this.setPhase('starting');
    this.beat();
    this.timer = setInterval(() => this.beat(), heartbeatMs);
    this.timer.unref?.();
    try {
      this.worker = new Worker(WORKER_PATH, {
        workerData: {
          sab: this.sab,
          thresholdMs: this.opts.thresholdMs ?? 30_000,
          checkMs: Math.min(heartbeatMs, 2000),
          action: this.opts.action ?? 'abort',
          reportPath: this.opts.reportPath ?? null,
        },
      });
      this.worker.unref();
      this.worker.on('error', (e) => console.error('[liveness-watchdog] worker error:', e.message));
      // Wire the phase channel so labelled synchronous spans (compression,
      // context-build, merge-graph walks) name themselves in a wedge report.
      phaseChannel.report = (label: string) => this.setPhase(label);
      console.error(
        `[liveness-watchdog] armed: threshold=${this.opts.thresholdMs ?? 30_000}ms ` +
          `action=${this.opts.action ?? 'abort'}`,
      );
    } catch (e) {
      console.error('[liveness-watchdog] failed to start:', (e as Error).message);
    }
    this.setPhase('idle');
  }

  /** Stamp liveness. Called on a timer; the worker watches for staleness. */
  private beat(): void {
    this.hb[0] = Date.now();
  }

  /**
   * Label the operation the main thread is about to run synchronously, so a
   * wedge report names it (e.g. 'compression-tick', 'context-build'). Keep it
   * short (truncated to 48 bytes). Reset to 'idle' when done.
   */
  setPhase(label: string): void {
    this.phaseBuf.fill(0);
    const bytes = this.enc.encode(label);
    this.phaseBuf.set(bytes.subarray(0, PHASE_LEN));
  }

  /** Run a synchronous section under a named phase, restoring the prior phase. */
  withPhase<T>(label: string, fn: () => T): T {
    this.setPhase(label);
    try {
      return fn();
    } finally {
      this.setPhase('idle');
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    phaseChannel.report = () => {};
    void this.worker?.terminate();
    this.worker = undefined;
    this.started = false;
  }
}
