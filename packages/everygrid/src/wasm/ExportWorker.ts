/**
 * ExportWorker.ts
 * Web Worker that builds the Excel export off the main thread so the UI never freezes.
 * The main thread streams row chunks in; this worker flattens them, writes .xlsx files
 * (one per ROWS_PER_FILE rows), and — when there is more than one file — zips them, then
 * posts the resulting bytes back. The heavy work (XLSX.write, zipSync) all happens here.
 */
import {ExcelView} from '../core/ExcelView';
import {zipSync} from 'fflate';

const ROWS_PER_FILE = 200000;

type InMsg =
  | {type: 'init'; baseName: string; expectedFiles: number}
  | {type: 'chunk'; rows: unknown[]}
  | {type: 'end'};

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<InMsg>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

let baseName = 'everygrid_export';
let expectedFiles = 1;
let header: string[] | null = null;
let acc: Record<string, unknown>[] = [];
const files: {name: string; bytes: Uint8Array}[] = [];

function flush() {
  if (acc.length === 0) return;
  files.push({name: `${baseName}_part${files.length + 1}.xlsx`, bytes: ExcelView.buildXlsxBuffer(acc, header || [])});
  acc = [];
  ctx.postMessage({type: 'progress', done: files.length, total: expectedFiles});
}

ctx.onmessage = (e: MessageEvent<InMsg>) => {
  try {
    const msg = e.data;
    if (msg.type === 'init') {
      baseName = msg.baseName;
      expectedFiles = msg.expectedFiles;
    } else if (msg.type === 'chunk') {
      const flat = msg.rows.map(r => ExcelView.flattenObjectForExcel(r));
      if (!header) header = ExcelView.unionHeader(flat);
      for (const row of flat) {
        acc.push(row);
        if (acc.length >= ROWS_PER_FILE) flush();
      }
      // Backpressure: tell the main thread this chunk is consumed so it can send the next one
      // (bounds the number of in-flight chunk copies to one).
      ctx.postMessage({type: 'ack'});
    } else if (msg.type === 'end') {
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
