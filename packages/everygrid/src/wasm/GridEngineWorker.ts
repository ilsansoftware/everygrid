/**
 * GridEngineWorker.ts
 * Web Worker script — runs inside a dedicated worker thread.
 * Loads the Rust WASM module and handles postMessage commands from the main thread.
 * Each GridEngine instance is keyed by an `id` so one worker can serve multiple grids.
 * Each grid has its own independent command queue to prevent interleaving.
 */

import init, { GridEngine } from 'everygrid-wasm';

// ---- Types shared between worker and main thread --------------------------------

export type WorkerRequest =
  | { id: string; seq: number; cmd: 'init' }
  | { id: string; seq: number; cmd: 'setData'; bytes: Uint8Array }
  | { id: string; seq: number; cmd: 'appendChunk'; bytes: Uint8Array }
  | { id: string; seq: number; cmd: 'streamStart' }
  | { id: string; seq: number; cmd: 'streamChunk'; bytes: Uint8Array }
  | { id: string; seq: number; cmd: 'streamEnd' }
  | { id: string; seq: number; cmd: 'filterSortAndGetPage'; text: string; col: string; asc: boolean; page: number; pageSize: number }
  | { id: string; seq: number; cmd: 'getPage'; page: number; pageSize: number }
  | { id: string; seq: number; cmd: 'getRawPage'; page: number; pageSize: number }
  | { id: string; seq: number; cmd: 'getTotalCount' }
  | { id: string; seq: number; cmd: 'getRawCount' }
  | { id: string; seq: number; cmd: 'updateRows'; indices: Uint32Array; rowsJson: string }
  | { id: string; seq: number; cmd: 'insertRows'; index: number; rowsJson: string }
  | { id: string; seq: number; cmd: 'removeRows'; indices: Uint32Array }
  | { id: string; seq: number; cmd: 'finalize' };

export type WorkerResponse =
  | { id: string; seq: number; ok: true; result?: unknown }
  | { id: string; seq: number; ok: false; error: string }
  | { id: string; seq: -1; type: 'progress'; stage: 'indexing' | 'ready'; progress: number };

// ---- Worker state ---------------------------------------------------------------

const engines = new Map<string, GridEngine>();

function getEngine(id: string): GridEngine {
  const e = engines.get(id);
  if (!e) throw new Error(`No engine for id="${id}". Call init first.`);
  return e;
}

// ---- Streaming byte-scan state --------------------------------------------------
// Raw fetch bytes are transferred here (zero-copy) and parsed off the main thread.
// A brace-depth scan over the raw bytes extracts complete top-level JSON objects,
// which are concatenated (newline-separated) and handed to WASM's feed_chunk_bytes.
// serde_json reads them as a sequence of values, so no array/comma framing is needed.

interface StreamState {
  carry: Uint8Array;      // leftover bytes of an incomplete trailing object (always begins at '{')
  total: number;          // complete objects fed so far
  pending: Uint8Array[];  // complete object byte-spans awaiting a batched feed
  pendingBytes: number;   // approximate byte size of `pending`
}

const _streamState = new Map<string, StreamState>();

const BYTE_OBJ_OPEN = 0x7B;   // {
const BYTE_OBJ_CLOSE = 0x7D;  // }
const BYTE_QUOTE = 0x22;      // "
const BYTE_BACKSLASH = 0x5C;  // backslash
const BYTE_NEWLINE = 0x0A;    // \n
const FEED_MAX_OBJECTS = 20_000;
const FEED_MAX_BYTES = 16 * 1024 * 1024;

// Flush accumulated complete objects into WASM as one newline-joined byte batch.
function feedPending(id: string, st: StreamState): void {
  if (st.pending.length === 0) return;
  const out = new Uint8Array(st.pendingBytes + (st.pending.length - 1));
  let off = 0;
  for (let i = 0; i < st.pending.length; i++) {
    if (i > 0) out[off++] = BYTE_NEWLINE;
    out.set(st.pending[i], off);
    off += st.pending[i].length;
  }
  getEngine(id).feed_chunk_bytes(out);
  st.pending = [];
  st.pendingBytes = 0;
}

// Scan raw bytes for complete top-level objects. ASCII { } " \ never collide with
// UTF-8 continuation bytes (>= 0x80), so scanning raw bytes is safe without decoding.
function scanStreamChunk(id: string, st: StreamState, chunk: Uint8Array): void {
  let buf: Uint8Array;
  if (st.carry.length > 0) {
    buf = new Uint8Array(st.carry.length + chunk.length);
    buf.set(st.carry, 0);
    buf.set(chunk, st.carry.length);
  } else {
    buf = chunk;
  }

  let depth = 0;
  let inObject = false;
  let inString = false;
  let escape = false;
  let objStart = -1;
  const n = buf.length;

  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (b === BYTE_BACKSLASH) escape = true;
      else if (b === BYTE_QUOTE) inString = false;
      continue;
    }
    if (b === BYTE_QUOTE) { inString = true; continue; }
    if (b === BYTE_OBJ_OPEN) {
      if (!inObject) { inObject = true; objStart = i; depth = 0; }
      depth++;
    } else if (b === BYTE_OBJ_CLOSE) {
      if (inObject) {
        depth--;
        if (depth === 0) {
          const span = buf.subarray(objStart, i + 1);
          st.pending.push(span);
          st.pendingBytes += span.length;
          st.total++;
          inObject = false;
          objStart = -1;
          if (st.pending.length >= FEED_MAX_OBJECTS || st.pendingBytes >= FEED_MAX_BYTES) {
            feedPending(id, st);
          }
        }
      }
    }
  }

  // Preserve any incomplete trailing object for the next chunk. slice() copies so the
  // transferred chunk buffer is not retained by a view. Bytes outside an object
  // (leading '[', commas, whitespace, trailing ']') are insignificant and dropped.
  st.carry = (inObject && objStart >= 0) ? buf.slice(objStart) : new Uint8Array(0);
}

// ---- Per-grid independent queues ------------------------------------------------
// Each grid has its own queue and processing flag.
// This ensures commands for grid-A never interleave with commands for grid-B.

const _gridQueues = new Map<string, MessageEvent<WorkerRequest>[]>();
const _gridProcessing = new Map<string, boolean>();

function getQueue(id: string): MessageEvent<WorkerRequest>[] {
  if (!_gridQueues.has(id)) _gridQueues.set(id, []);
  return _gridQueues.get(id)!;
}

// WASM init promise — resolved once before any message is processed
let _wasmInitPromise: Promise<void> | undefined;

function ensureWasmOnce(): Promise<void> {
  if (!_wasmInitPromise) {
    _wasmInitPromise = init().then(() => {});
  }
  return _wasmInitPromise;
}

async function processGridQueue(id: string) {
  if (_gridProcessing.get(id)) return;
  _gridProcessing.set(id, true);

  // Wait for WASM to be ready once, then drain the queue synchronously.
  await ensureWasmOnce();

  const queue = getQueue(id);
  while (queue.length > 0) {
    const event = queue.shift()!;
    // handleMessage is fully synchronous — no await, no microtask checkpoint.
    handleMessage(event);
  }

  _gridProcessing.set(id, false);
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id } = event.data;
  getQueue(id).push(event);
  processGridQueue(id);
};

// Runs one command and returns its result (or throws). Kept separate from handleMessage so a
// thrown error propagates to that function's catch rather than being "thrown and caught locally".
function executeCommand(req: WorkerRequest): unknown {
  const { id, cmd } = req;
  // WASM is guaranteed ready by processGridQueue's ensureWasmOnce() — no await here.
  let result: unknown;

  switch (cmd) {
      case 'init': {
        // Always create a fresh engine — free any stale one from a previous session
        const stale = engines.get(id);
        if (stale) { try { stale.free(); } catch { /* ignore */ } }
        engines.set(id, new GridEngine());
        break;
      }

      case 'setData': {
        // Clear existing data then feed first chunk (no recompute yet)
        getEngine(id).clear();
        getEngine(id).feed_chunk_bytes(req.bytes);
        break;
      }

      case 'appendChunk': {
        getEngine(id).feed_chunk_bytes(req.bytes);
        break;
      }

      case 'streamStart': {
        // Clear existing data and reset the streaming scanner for this grid.
        getEngine(id).clear();
        _streamState.set(id, { carry: new Uint8Array(0), total: 0, pending: [], pendingBytes: 0 });
        break;
      }

      case 'streamChunk': {
        const st = _streamState.get(id);
        if (!st) throw new Error(`streamChunk before streamStart for id="${id}"`);
        scanStreamChunk(id, st, req.bytes);
        result = { total: st.total };
        break;
      }

      case 'streamEnd': {
        const st = _streamState.get(id);
        if (st) {
          feedPending(id, st);
          _streamState.delete(id);
        }
        // finalize triggers lazy index build via recompute (same as setData's finalize).
        getEngine(id).finalize();
        break;
      }

      case 'finalize': {
        getEngine(id).finalize();
        break;
      }

      case 'updateRows': {
        getEngine(id).update_rows(req.indices, req.rowsJson);
        break;
      }

      case 'insertRows': {
        getEngine(id).insert_rows(req.index, req.rowsJson);
        break;
      }

      case 'removeRows': {
        getEngine(id).remove_rows(req.indices);
        break;
      }

      case 'filterSortAndGetPage': {
        const raw = getEngine(id).filter_sort_and_get_page(req.text, req.col, req.asc, req.page, req.pageSize);
        result = typeof raw === 'string' ? JSON.parse(raw) : (raw as { rows: unknown[]; filtered: number; raw: number });
        break;
      }

      case 'getPage': {
        const engine = getEngine(id);
        const raw = engine.get_page(req.page, req.pageSize);
        const rows: unknown[] = typeof raw === 'string' ? JSON.parse(raw) : (raw as unknown[]);
        const total = engine.get_total_count();
        result = { rows, total };
        break;
      }

      case 'getRawPage': {
        const engine = getEngine(id);
        const raw = engine.get_raw_page(req.page, req.pageSize);
        const rows: unknown[] = typeof raw === 'string' ? JSON.parse(raw) : (raw as unknown[]);
        const total = engine.get_raw_count();
        result = { rows, total };
        break;
      }

      case 'getTotalCount': {
        result = getEngine(id).get_total_count();
        break;
      }

      case 'getRawCount': {
        result = getEngine(id).get_raw_count();
        break;
      }

      default:
        throw new Error(`Unknown command: ${(req as WorkerRequest).cmd}`);
    }

  return result;
}

function handleMessage(event: MessageEvent<WorkerRequest>) {
  const { id, seq } = event.data;
  try {
    const result = executeCommand(event.data);
    const resp: WorkerResponse = { id, seq, ok: true, result };
    self.postMessage(resp);
  } catch (err) {
    const resp: WorkerResponse = {
      id,
      seq,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(resp);
  }
}
