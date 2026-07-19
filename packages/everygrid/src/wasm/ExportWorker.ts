/**
 * ExportWorker.ts
 * Web Worker that builds the Excel export off the main thread so the UI never freezes.
 * The main thread streams row chunks in; this worker flattens them and writes .xlsx files
 * (one per ROWS_PER_FILE rows), zipping when there is more than one, then posts the bytes back.
 *
 * Two modes:
 *  - single sheet: one flat table (splits into part files at ROWS_PER_FILE, zips if >1).
 *  - relational: a parent sheet + one child sheet per object array, each streamed and part-split
 *    the same way, then all part files are zipped together. Keeps memory bounded (~ROWS_PER_FILE
 *    rows per sheet at a time) so even very large inputs don't materialise the whole workbook.
 */
import {ExcelView} from '../core/ExcelView';
import {zipSync} from 'fflate';

const ROWS_PER_FILE = 200000;

type InMsg =
  | {type: 'init'; baseName: string; expectedFiles: number; relational?: boolean; keyField?: string}
  | {type: 'chunk'; rows: unknown[]}
  | {type: 'end'};

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<InMsg>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

let baseName = 'everygrid_export';
let expectedFiles = 1;
let relational = false;
let keyField: string | undefined;

// --- single-sheet mode ---
let header: string[] | null = null;
let acc: Record<string, unknown>[] = [];
const files: {name: string; bytes: Uint8Array}[] = [];

function flush() {
  if (acc.length === 0) return;
  files.push({name: `${baseName}_part${files.length + 1}.xlsx`, bytes: ExcelView.buildXlsxBuffer(acc, header || [])});
  acc = [];
  ctx.postMessage({type: 'progress', done: files.length, total: expectedFiles});
}

// --- relational mode ---
// Windowed & self-contained: every RELATIONAL_WINDOW parent rows are flushed to ONE workbook file
// holding that parent slice PLUS its child sheets as tabs, then all files are zipped. Keeps the
// parent split fine-grained and each file usable on its own; memory is bounded to one window.
const RELATIONAL_WINDOW = 100000;
let rowNum = 0;
let fileIndex = 0;
const relEntries: Record<string, Uint8Array> = {};
// Current window: the parent slice + child rows (grouped by depth-1 field), reset after each flush.
let winParent: Record<string, unknown>[] = [];
let winChildren = new Map<string, Record<string, unknown>[]>();
// Discovered across the whole stream (order/type stability), not reset per window.
const childFields = new Set<string>();
const keyedFields = new Set<string>();

function emitWindow() {
  if (winParent.length === 0 && winChildren.size === 0) return;
  const sheets: {name: string; rows: Record<string, unknown>[]; front?: string[]}[] =
    [{name: 'main', rows: winParent}];
  for (const [field, rows] of winChildren) {
    sheets.push({name: field, rows, front: ['_mainSheetRowNum', '_idx']});
  }
  fileIndex++;
  relEntries[`${baseName}_${fileIndex}.xlsx`] = ExcelView.buildMultiSheetXlsx(sheets);
  winParent = [];
  winChildren = new Map();
}

function addRelationalChunk(rows: unknown[]) {
  for (const r of rows) {
    rowNum++;
    // Parent row: original record flattened (object arrays stay inline). No synthetic row-number.
    winParent.push(ExcelView.flattenObjectForExcel(r));

    const rec = r as Record<string, unknown>;
    const keyVal = keyField ? rec[keyField] : undefined;
    const keyCol = (keyField && keyVal !== undefined) ? {[keyField]: keyVal} : {};
    // Any depth-1 field with an array (here or in an earlier record) → a decomposed child sheet.
    for (const path of ExcelView.arrayPaths([rec])) childFields.add(path[0]);
    for (const field of childFields) {
      const val = rec[field];
      if (val === undefined || val === null) continue;
      if (typeof val === 'object' && !Array.isArray(val)) keyedFields.add(field);
      let acc = winChildren.get(field);
      if (!acc) { acc = []; winChildren.set(field, acc); }
      // Decompose the whole field: every sub-key → a row (see ExcelView.decomposeToRows).
      const decomposed: Record<string, unknown>[] = [];
      ExcelView.decomposeToRows(val, '', decomposed, keyedFields.has(field));
      for (const row of decomposed) acc.push({_mainSheetRowNum: rowNum, ...keyCol, ...row});
    }

    // Flush after a full parent row so a row's children never split across files.
    if (winParent.length >= RELATIONAL_WINDOW) emitWindow();
  }
}

function finishRelational() {
  emitWindow();
  const names = Object.keys(relEntries);
  if (names.length === 0) {
    const bytes = ExcelView.buildMultiSheetXlsx([{name: 'main', rows: []}]);
    ctx.postMessage({type: 'done', isZip: false, bytes}, [bytes.buffer as ArrayBuffer]);
  } else if (names.length === 1) {
    const bytes = relEntries[names[0]];
    ctx.postMessage({type: 'done', isZip: false, bytes}, [bytes.buffer as ArrayBuffer]);
  } else {
    const zipped = zipSync(relEntries, {level: 0}); // entries are already xlsx-compressed
    ctx.postMessage({type: 'done', isZip: true, bytes: zipped}, [zipped.buffer as ArrayBuffer]);
  }
}

ctx.onmessage = (e: MessageEvent<InMsg>) => {
  try {
    const msg = e.data;
    if (msg.type === 'init') {
      baseName = msg.baseName;
      expectedFiles = msg.expectedFiles;
      relational = !!msg.relational;
      keyField = msg.keyField;
    } else if (msg.type === 'chunk') {
      if (relational) {
        addRelationalChunk(msg.rows);
      } else {
        const flat = msg.rows.map(r => ExcelView.flattenObjectForExcel(r));
        if (!header) header = ExcelView.unionHeader(flat);
        for (const row of flat) {
          acc.push(row);
          if (acc.length >= ROWS_PER_FILE) flush();
        }
      }
      // Backpressure: tell the main thread this chunk is consumed so it can send the next one
      // (bounds the number of in-flight chunk copies to one).
      ctx.postMessage({type: 'ack'});
    } else if (msg.type === 'end') {
      if (relational) {
        finishRelational();
        return;
      }
      flush();
      if (files.length === 0) {
        files.push({name: `${baseName}.xlsx`, bytes: ExcelView.buildXlsxBuffer([], header || [])});
      }
      if (files.length === 1) {
        const bytes = files[0].bytes;
        ctx.postMessage({type: 'done', isZip: false, bytes}, [bytes.buffer as ArrayBuffer]);
      } else {
        const entries: Record<string, Uint8Array> = {};
        files.forEach(f => { entries[f.name] = f.bytes; });
        const zipped = zipSync(entries, {level: 0}); // entries are already xlsx-compressed
        ctx.postMessage({type: 'done', isZip: true, bytes: zipped}, [zipped.buffer as ArrayBuffer]);
      }
    }
  } catch (err) {
    ctx.postMessage({type: 'error', message: err instanceof Error ? err.message : String(err)});
  }
};
