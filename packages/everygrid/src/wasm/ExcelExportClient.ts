/**
 * ExcelExportClient.ts
 * Main-thread driver for the Excel export worker. Streams row chunks (from in-memory data or the
 * WASM engine) into ExportWorker, relays progress, and resolves with the final bytes to download.
 */
// The `?worker` suffix tells Vite to bundle the file as a Worker entry point.
// (For the standalone UMD build vite.config rewrites this to `?worker&inline`.)
import ExportWorker from './ExportWorker?worker';

const ROWS_PER_FILE = 200000;

export interface ExportResult {
  bytes: Uint8Array;
  isZip: boolean;
}

export function runExcelExport(opts: {
  baseName: string;
  total: number;
  chunkSize: number;
  fetchChunk: (page: number, size: number) => Promise<unknown[]>;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  // Relational: parent sheet + a child sheet per object array, streamed and zipped in the worker.
  relational?: boolean;
  keyField?: string;
}): Promise<ExportResult> {
  const {baseName, total, chunkSize, fetchChunk, onProgress, signal, relational, keyField} = opts;
  const expectedFiles = Math.max(1, Math.ceil(total / ROWS_PER_FILE));

  return new Promise<ExportResult>((resolve, reject) => {
    const worker: Worker = new ExportWorker();
    let ackResolve: (() => void) | null = null;
    let ackReject: ((e: unknown) => void) | null = null;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      fn();
    };
    function onAbort() {
      const err = new DOMException('Export cancelled', 'AbortError');
      const rej = ackReject; ackResolve = ackReject = null; rej?.(err); // unblock the send loop
      finish(() => reject(err));
    }

    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, {once: true});

    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'ack') {
        const r = ackResolve; ackResolve = ackReject = null; r?.();
      } else if (m.type === 'progress') {
        onProgress?.(m.done, m.total);
      } else if (m.type === 'done') {
        finish(() => resolve({bytes: m.bytes as Uint8Array, isZip: m.isZip as boolean}));
      } else if (m.type === 'error') {
        finish(() => reject(new Error(m.message)));
      }
    };
    worker.onerror = (err) => finish(() => reject(err instanceof ErrorEvent ? err.error : err));

    (async () => {
      worker.postMessage({type: 'init', baseName, expectedFiles, relational, keyField});
      const totalPages = Math.max(1, Math.ceil(total / chunkSize));
      for (let page = 0; page < totalPages; page++) {
        if (settled) return;
        const rows = await fetchChunk(page, chunkSize);
        if (settled || !rows || rows.length === 0) break;
        // Send one chunk, then wait for the worker to consume it before fetching/sending the next.
        const acked = new Promise<void>((res, rej) => { ackResolve = res; ackReject = rej; });
        worker.postMessage({type: 'chunk', rows});
        await acked;
        // Relational builds no part files until the end, so drive progress by chunks consumed
        // (single-sheet mode reports its own file-based progress from the worker instead).
        if (relational) onProgress?.(page + 1, totalPages);
      }
      if (!settled) worker.postMessage({type: 'end'});
    })().catch(err => finish(() => reject(err)));
  });
}
