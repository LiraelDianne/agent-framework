/**
 * Worker that runs the agent-authored `gate.js` decision function.
 *
 * The agent is trusted (it already has shell + filesystem), so this is NOT a
 * security sandbox — it's a *robustness* boundary: running the script on a
 * separate thread lets the main thread time it out (Atomics.wait) so an
 * accidental infinite loop degrades to "fall through to declarative policies"
 * instead of freezing the agent's own event loop.
 *
 * Protocol:
 *   - on startup we import `gate.js` and post `{ type: 'ready', error? }`.
 *   - per event the parent posts `{ type: 'eval', event }`; we run the script
 *     and write the JSON result into the shared buffer, flip the control word,
 *     and notify. The parent is blocked in Atomics.wait until then (or times out).
 *
 * `gate.js` shape (ESM): `export default (event) => behavior | null` where
 * behavior is a GateBehavior ('always' | 'defer' | { debounce } | …) and null
 * means "let the declarative gate.json policies decide". Sync or async.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

interface WorkerData {
  scriptPath: string;
  sab: SharedArrayBuffer;
}
const { scriptPath, sab } = workerData as WorkerData;
const ctrl = new Int32Array(sab, 0, 2); // [0]=status (0 pending, 1 done), [1]=result byte length
const data = new Uint8Array(sab, 8);
const enc = new TextEncoder();

type DecideFn = (event: unknown) => unknown;
let fn: DecideFn | null = null;

// Load eagerly and announce readiness, so the parent doesn't time out (and
// pointlessly respawn) while a cold dynamic import is still in flight.
void (async () => {
  let error: string | null = null;
  try {
    const mod = (await import(pathToFileURL(scriptPath).href)) as Record<string, unknown>;
    const f = (mod.default ?? mod.decide ?? mod.gate) as unknown;
    if (typeof f !== 'function') {
      error = 'gate.js must export a default function: (event) => behavior | null';
    } else {
      fn = f as DecideFn;
    }
  } catch (e) {
    error = (e as Error)?.message ?? String(e);
  }
  parentPort?.postMessage({ type: 'ready', error });
})();

function writeResult(obj: unknown): void {
  const bytes = enc.encode(JSON.stringify(obj));
  const n = Math.min(bytes.length, data.length);
  data.set(bytes.subarray(0, n));
  Atomics.store(ctrl, 1, n);
  Atomics.store(ctrl, 0, 1);
  Atomics.notify(ctrl, 0);
}

parentPort?.on('message', (msg: { type?: string; event?: unknown }) => {
  if (msg?.type !== 'eval') return;
  void (async () => {
    if (!fn) return writeResult({ behavior: null }); // load failed → fall through
    try {
      const r = await fn(msg.event); // sync OR async decision functions
      writeResult({ behavior: r ?? null });
    } catch (e) {
      writeResult({ error: (e as Error)?.message ?? String(e) });
    }
  })();
});
