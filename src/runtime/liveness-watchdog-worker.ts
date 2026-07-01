/**
 * Liveness watchdog worker — runs on its own thread, so it keeps ticking even
 * when the main thread is wedged. Watches the shared heartbeat; if it goes stale
 * past the threshold, writes a diagnostic and kills the whole process.
 *
 * Killing from a worker: process.kill(process.pid, signal) signals the whole
 * process. SIGABRT → core dump (if enabled) + terminate; SIGKILL → immediate.
 * Catchable signals (SIGTERM) are avoided — their handler would run on the
 * wedged main thread and never fire.
 */
import { workerData } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';

interface Data {
  sab: SharedArrayBuffer;
  thresholdMs: number;
  checkMs: number;
  action: 'abort' | 'exit';
  reportPath: string | null;
}
const { sab, thresholdMs, checkMs, action, reportPath } = workerData as Data;

const hb = new Float64Array(sab, 0, 1);
const phaseBuf = new Uint8Array(sab, 16, 48);
const dec = new TextDecoder();

function currentPhase(): string {
  return dec.decode(phaseBuf).replace(/\0+$/, '') || 'unknown';
}

function check(): void {
  const last = hb[0];
  const age = Date.now() - last;
  if (last > 0 && age > thresholdMs) {
    const phase = currentPhase();
    const report = {
      ts: new Date().toISOString(),
      event: 'main-thread-wedged',
      ageMs: Math.round(age),
      thresholdMs,
      phase,
      action,
      pid: process.pid,
    };
    const line = `[liveness-watchdog] main thread unresponsive ${Math.round(age)}ms ` +
      `(phase=${phase}) — failing hard via ${action}`;
    try {
      console.error(line);
    } catch {
      /* ignore */
    }
    if (reportPath) {
      try {
        writeFileSync(reportPath, JSON.stringify(report) + '\n', { flag: 'a' });
      } catch {
        /* best effort */
      }
    }
    // Kill the whole process. The supervisor restarts a fresh one.
    process.kill(process.pid, action === 'abort' ? 'SIGABRT' : 'SIGKILL');
    return; // process is dying
  }
  setTimeout(check, checkMs);
}

setTimeout(check, checkMs);
