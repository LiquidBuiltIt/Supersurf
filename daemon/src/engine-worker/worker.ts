/**
 * Engine worker entry. The ONLY daemon source file that names the engine
 * (`engine-not-loaded.test.ts` enforces it): the engine loads here, on the
 * worker thread, never on the daemon's main thread. Run as a `Worker` it starts
 * on `parentPort`; tests call `startEngineSide` directly with an injected engine.
 *
 * Built layout: `dist/engine-worker/worker.js` finds `dist/engine/index.js`.
 *
 * @module engine-worker/worker
 */
import path from 'node:path';
import { isMainThread, parentPort } from 'node:worker_threads';
import { createEngineSide, type EngineModule, type WorkerPort } from './core';

export function startEngineSide(port: WorkerPort, engine?: EngineModule): { shutdown(): Promise<void> } {
  const side = createEngineSide(port, engine ?? require(path.join(__dirname, '../engine/index.js')));
  port.postMessage({ t: 'ready' });
  return side;
}

if (!isMainThread && parentPort) startEngineSide(parentPort as unknown as WorkerPort);
