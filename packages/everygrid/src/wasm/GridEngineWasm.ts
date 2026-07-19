/**
 * GridEngineWasm.ts
 * Main-thread proxy for the WASM GridEngine running inside a Web Worker.
 * All heavy operations (setData, filter, sort, getPage) execute off the main thread,
 * so the UI never freezes even with millions of rows.
 */

import type { WorkerRequest, WorkerResponse } from './GridEngineWorker';

// Vite: import the worker as a module worker (type: 'module')
// The `?worker` suffix tells Vite to bundle the file as a Worker entry point.
import GridWorker from './GridEngineWorker?worker';

// ---- Per-instance worker -------------------------------------------------------
// Each GridEngineWasm instance owns its own Worker so that one grid's heavy
// operations (e.g. streaming 1 GB) never block another grid's requests.

const _encoder = new TextEncoder();

// ---- GridEngineWasm ------------------------------------------------------------

export class GridEngineWasm {
  private readonly engineId: string;
  private readonly worker: Worker;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private progressCallback?: (stage: 'indexing' | 'ready', progress: number) => void;

  private constructor(engineId: string) {
    this.engineId = engineId;
    this.worker = new GridWorker();
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const resp = event.data;
      if (resp.seq === -1) {
        const prog = resp as { id: string; seq: -1; type: 'progress'; stage: 'indexing' | 'ready'; progress: number };
        if (this.progressCallback) this.progressCallback(prog.stage, prog.progress);
        return;
      }
      const r = resp as { id: string; seq: number; ok: boolean; result?: unknown; error?: string };
      const handler = this.pending.get(r.seq);
      if (!handler) return;
      this.pending.delete(r.seq);
      if (r.ok) handler.resolve(r.result);
      else handler.reject(new Error(r.error ?? 'Unknown error'));
    };
    this.worker.onerror = (err) => {
      console.error('[GridEngineWasm] Worker error:', err);
    };
  }

  private send(req: Omit<WorkerRequest, 'seq'>, transfer?: Transferable[]): Promise<unknown> {
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      const msg = { ...req, seq } as WorkerRequest;
      if (transfer && transfer.length > 0) {
        this.worker.postMessage(msg, transfer);
      } else {
        this.worker.postMessage(msg);
      }
    });
  }

  /** Creates a new engine instance with its own dedicated Worker. */
  static async create(engineId: string, onProgress?: (stage: 'indexing' | 'ready', progress: number) => void): Promise<GridEngineWasm> {
    const instance = new GridEngineWasm(engineId);
    if (onProgress) instance.progressCallback = onProgress;
    await instance.send({ id: engineId, cmd: 'init' });
    console.log(`[WASM Worker] GridEngine created: ${engineId}`);
    return instance;
  }

  /** Loads the full dataset. Runs in the worker — non-blocking. */
  async setData(data: unknown[], reportProgress = true): Promise<void> {
    // Send batches sequentially to prevent interleaving with other grid's chunks in the shared worker.
    const BATCH = 10_000;
    const totalBatches = Math.ceil(data.length / BATCH) || 1;
    const cb = reportProgress ? this.progressCallback : undefined;
    // Notify indexing started (0%) before batch upload begins
    if (cb) cb('indexing', 0);
    for (let i = 0; i < data.length; i += BATCH) {
      const slice = data.slice(i, i + BATCH);
      const bytes = _encoder.encode(JSON.stringify(slice));
      if (i === 0) {
        await this.send({ id: this.engineId, cmd: 'setData' as const, bytes } as Omit<WorkerRequest, 'seq'>, [bytes.buffer]);
      } else {
        await this.send({ id: this.engineId, cmd: 'appendChunk' as const, bytes } as Omit<WorkerRequest, 'seq'>, [bytes.buffer]);
      }
      // Each batch is awaited (sent + parsed in the worker) and no eager index build runs at
      // load, so batch progress IS the true indexing progress. Map to 0–100%, capped at 99%
      // until finalize confirms completion below.
      if (cb) {
        const batchIndex = Math.floor(i / BATCH) + 1;
        const pct = Math.min(99, Math.round((batchIndex / totalBatches) * 100));
        cb('indexing', pct);
      }
    }
    // finalize triggers build_index in WASM — Worker will send 'ready' when done
    await this.send({ id: this.engineId, cmd: 'finalize' as const });
    // finalize complete → 100%
    if (cb) cb('ready', 100);
  }

  /**
   * Streaming load — begin. Clears the engine and resets the worker-side byte scanner.
   * Pair with streamChunk() (many) and streamEnd() (once).
   */
  async streamStart(reportProgress = true): Promise<void> {
    if (reportProgress && this.progressCallback) this.progressCallback('indexing', 0);
    await this.send({ id: this.engineId, cmd: 'streamStart' as const } as Omit<WorkerRequest, 'seq'>);
  }

  /**
   * Streaming load — feed one raw byte chunk straight from fetch's ReadableStream.
   * The buffer is transferred (zero-copy); the caller must not reuse `bytes` afterward.
   * All JSON parsing happens in the worker, so the main thread never blocks.
   * @returns running total of complete rows parsed so far.
   */
  async streamChunk(bytes: Uint8Array): Promise<number> {
    const res = await this.send(
      { id: this.engineId, cmd: 'streamChunk' as const, bytes } as Omit<WorkerRequest, 'seq'>,
      [bytes.buffer],
    );
    return (res as { total: number }).total;
  }

  /** Streaming load — finish. Flushes remaining rows and builds the index in the worker. */
  async streamEnd(reportProgress = true): Promise<void> {
    await this.send({ id: this.engineId, cmd: 'streamEnd' as const } as Omit<WorkerRequest, 'seq'>);
    if (reportProgress && this.progressCallback) this.progressCallback('ready', 100);
  }

  /** Appends a chunk to the existing dataset. */
  appendChunk(chunk: unknown[]): Promise<void> {
    const bytes = _encoder.encode(JSON.stringify(chunk));
    const req = { id: this.engineId, cmd: 'appendChunk' as const, bytes };
    return this.send(req, [bytes.buffer]) as Promise<void>;
  }

  /** Applies a filter expression. */
  filter(text: string): Promise<void> {
    const req = { id: this.engineId, cmd: 'filter' as const, text };
    return this.send(req) as Promise<void>;
  }

  /** Sorts by a column. */
  sort(col: string, asc: boolean): Promise<void> {
    const req = { id: this.engineId, cmd: 'sort' as const, col, asc };
    return this.send(req) as Promise<void>;
  }

  /** Applies filter and sort in a single recompute pass (faster than calling filter + sort separately). */
  filterAndSort(text: string, col: string, asc: boolean): Promise<void> {
    const req = { id: this.engineId, cmd: 'filterAndSort' as const, text, col, asc };
    return this.send(req) as Promise<void>;
  }

  /** Applies filter+sort and fetches the page in a single atomic Worker call — prevents interleaving. */
  async filterSortAndGetPage(
    text: string, col: string, asc: boolean, page: number, pageSize: number
  ): Promise<{ rows: unknown[]; filtered: number; raw: number }> {
    const req = { id: this.engineId, cmd: 'filterSortAndGetPage' as const, text, col, asc, page, pageSize };
    return this.send(req) as Promise<{ rows: unknown[]; filtered: number; raw: number }>;
  }

  /** Returns a page of rows plus the filtered total. */
  async getPage(page: number, pageSize: number): Promise<{ rows: unknown[]; total: number }> {
    const req = { id: this.engineId, cmd: 'getPage' as const, page, pageSize };
    const result = await this.send(req);
    return result as { rows: unknown[]; total: number };
  }

  /** Returns a page of the raw (unfiltered) rows plus the raw total — used by "export all". */
  async getRawPage(page: number, pageSize: number): Promise<{ rows: unknown[]; total: number }> {
    const req = { id: this.engineId, cmd: 'getRawPage' as const, page, pageSize };
    const result = await this.send(req);
    return result as { rows: unknown[]; total: number };
  }

  /** Returns the filtered row count. */
  async getTotalCount(): Promise<number> {
    const result = await this.send({ id: this.engineId, cmd: 'getTotalCount' });
    return result as number;
  }

  /** Returns the raw (unfiltered) row count. */
  async getRawCount(): Promise<number> {
    const result = await this.send({ id: this.engineId, cmd: 'getRawCount' });
    return result as number;
  }

  /** Pre-warms the BTreeMap column index for fast filter/sort. */
  buildIndex(): Promise<void> {
    return this.send({ id: this.engineId, cmd: 'buildIndex' }) as Promise<void>;
  }

  /** Clears all data and resets the engine. */
  clear(): Promise<void> {
    return this.send({ id: this.engineId, cmd: 'clear' }) as Promise<void>;
  }

  /** Frees the engine inside the worker. */
  free(): Promise<void> {
    return this.send({ id: this.engineId, cmd: 'free' }) as Promise<void>;
  }

  /** Terminates the worker thread, releasing its WASM memory and the thread itself immediately.
   *  Each grid has its own worker, so this only affects this engine. */
  terminate(): void {
    this.worker.terminate();
  }
}
