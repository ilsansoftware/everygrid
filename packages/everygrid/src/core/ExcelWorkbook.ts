import XLSX from 'xlsx-js-style';
import {ExcelView} from './ExcelView';

// The parts of the Excel export that build workbooks with SheetJS. Kept apart from ExcelView (the
// on-screen table and the DOM-free row helpers) so SheetJS is only fetched when someone exports:
// Everygrid.exportExcel imports this module on demand, and the export worker bundles its own copy.

// `dense: true` is supported at runtime (stores cells in a 2D array instead of one property per
// cell, avoiding V8's ~8.4M-property enumeration limit) but missing from this version's types.
const DENSE = {dense: true} as unknown as Parameters<typeof XLSX.utils.aoa_to_sheet>[1];

export const ExcelWorkbook = {
  // Small / empty fallback: the rich DOM-table path (array expansion, merged cells). Large
  // exports are handled off-thread by the export worker (see Everygrid.exportExcel).
  downloadExcel: (data: unknown[], gridId?: string) => {
    const table = ExcelView.createExcelTable(data, undefined, true);
    ExcelWorkbook.downloadTableAsExcel(table, gridId);
  },

  // Build one compressed .xlsx (single sheet) as bytes from already-flattened rows. Dense sheet +
  // array rows avoid V8's property-enumeration limit; `compression` keeps the file small. Used by
  // the worker (DOM-free).
  buildXlsxBuffer: (flatRows: Record<string, unknown>[], header: string[]): Uint8Array => {
    const aoa = flatRows.map(row => header.map(k => { const v = row[k]; return v === undefined ? '' : v; }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...aoa], DENSE), 'Sheet1');
    // type:'array' returns an ArrayBuffer here — wrap so downstream (zip / Blob) gets a Uint8Array.
    const out = XLSX.write(wb, {type: 'array', bookType: 'xlsx', compression: true} as XLSX.WritingOptions);
    return new Uint8Array(out as ArrayBuffer);
  },

  // Build one compressed multi-sheet .xlsx (bytes) from several named row sets — used by the
  // worker's windowed relational export (a parent slice + its child sheets, per output file).
  buildMultiSheetXlsx: (sheets: {name: string; rows: Record<string, unknown>[]; front?: string[]}[]): Uint8Array => {
    const wb = XLSX.utils.book_new();
    const used = new Set<string>();
    for (const s of sheets) {
      const ws = ExcelWorkbook.sheetFromRows(s.rows, true, s.front || []);
      if (ws) XLSX.utils.book_append_sheet(wb, ws, ExcelView.sanitizeSheetName(s.name, used));
    }
    if (wb.SheetNames.length === 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Sheet1');
    const out = XLSX.write(wb, {type: 'array', bookType: 'xlsx', compression: true} as XLSX.WritingOptions);
    return new Uint8Array(out as ArrayBuffer);
  },

  downloadTableAsExcel: (table: HTMLTableElement, gridId?: string) => {
    const fileName = `everygrid_${gridId || 'export'}_${new Date().getTime()}.xlsx`;
    const wb = XLSX.utils.table_to_book(table);
    ExcelWorkbook.trimSheet(wb.Sheets[wb.SheetNames[0]]);
    ExcelWorkbook.styleSheet(wb.Sheets[wb.SheetNames[0]]);
    XLSX.writeFile(wb, fileName);
  },

  // Tighten a sheet's used range (!ref) to the cells that actually hold a value, dropping trailing
  // empty rows/columns some builders (e.g. table_to_book) leave behind — so viewers don't show a
  // large empty region hanging off the table. Interior blank cells (ragged data) are kept.
  trimSheet: (ws: XLSX.WorkSheet | undefined) => {
    if (!ws || !ws['!ref']) return;
    const range = XLSX.utils.decode_range(ws['!ref']);
    let minR = Infinity, minC = Infinity, maxR = -1, maxC = -1;
    for (let R = range.s.r; R <= range.e.r; R++) {
      for (let C = range.s.c; C <= range.e.c; C++) {
        const cell = ws[XLSX.utils.encode_cell({r: R, c: C})] as {v?: unknown} | undefined;
        const v = cell?.v;
        if (v === undefined || v === null || v === '') continue;
        if (R < minR) minR = R;
        if (R > maxR) maxR = R;
        if (C < minC) minC = C;
        if (C > maxC) maxC = C;
      }
    }
    if (maxR < 0) return; // no data at all
    // Drop cell entries outside the tight box.
    for (let R = range.s.r; R <= range.e.r; R++) {
      for (let C = range.s.c; C <= range.e.c; C++) {
        if (R >= minR && R <= maxR && C >= minC && C <= maxC) continue;
        delete ws[XLSX.utils.encode_cell({r: R, c: C})];
      }
    }
    ws['!ref'] = XLSX.utils.encode_range({s: {r: minR, c: minC}, e: {r: maxR, c: maxC}});
  },

  // Apply the standard cell style (top-aligned, word-wrapped) to every cell of a sheet.
  styleSheet: (ws: XLSX.WorkSheet | undefined) => {
    if (!ws) return;
    for (const key in ws) {
      if (key.startsWith('!')) continue;
      const cell = ws[key] as { s?: { alignment?: unknown } };
      if (!cell.s) cell.s = {};
      cell.s.alignment = {vertical: 'top', wrapText: true};
    }
  },

  // Build a worksheet from row objects (DOM-free): union header (with `front` columns pulled to the
  // left) + (optionally dense) aoa, trimmed and styled. Returns null for an empty row set.
  sheetFromRows: (rows: Record<string, unknown>[], dense = false, front: string[] = []): XLSX.WorkSheet | null => {
    if (rows.length === 0) return null;
    const header = ExcelView.orderHeader(ExcelView.unionHeader(rows), front);
    const aoa = rows.map(row => header.map(k => { const v = row[k]; return v === undefined ? '' : v; }));
    const ws = XLSX.utils.aoa_to_sheet([header, ...aoa], dense ? DENSE : undefined);
    ExcelWorkbook.trimSheet(ws);
    ExcelWorkbook.styleSheet(ws);
    return ws;
  },

  // Append one child sheet per depth-1 field that contains structured (array/object) data. Each
  // parent record's whole field value is decomposed (see decomposeToRows) — every sub-key becomes a
  // row (scalars in _value, object elements flattened, array position in _idx), keyed by _key —
  // linked back by _mainSheetRowNum with the parent key filled down.
  appendChildSheets: (
    wb: XLSX.WorkBook, records: Record<string, unknown>[], paths: string[][],
    keyField: string | undefined, used: Set<string>, dense = false,
  ) => {
    const fields = new Set(paths.map(p => p[0]));
    for (const field of fields) {
      // "Keyed" field: appears as a plain (keyed) object in some record → a bare scalar value of
      // this field is a key (e.g. role: "Developer"), not a plain value (e.g. language: "Korean").
      const keyed = records.some(r => {
        const v = r[field];
        return !!v && typeof v === 'object' && !Array.isArray(v);
      });
      const childRows: Record<string, unknown>[] = [];
      records.forEach((r, i) => {
        const val = r[field];
        if (val === undefined || val === null) return;
        // Fill-down the parent key so each child row shows which parent it belongs to.
        const keyCol = (keyField && r[keyField] !== undefined) ? {[keyField]: r[keyField]} : {};
        const rows: Record<string, unknown>[] = [];
        ExcelView.decomposeToRows(val, '', rows, keyed);
        for (const row of rows) childRows.push({_mainSheetRowNum: i + 1, ...keyCol, ...row});
      });
      const ws = ExcelWorkbook.sheetFromRows(childRows, dense, ['_mainSheetRowNum', '_idx']);
      if (ws) XLSX.utils.book_append_sheet(wb, ws, ExcelView.sanitizeSheetName(field, used));
    }
  },

  // Relational export with a RICH main sheet (the DOM table: merged headers, inline arrays). Best
  // for small/medium in-memory grids. Main sheet + one child sheet per structured field; child rows
  // link back via _mainSheetRowNum. No structured fields → an ordinary single-sheet export.
  downloadRelationalExcel: (rows: unknown[], gridId?: string, keyField?: string) => {
    const records = rows as Record<string, unknown>[];
    const paths = ExcelView.arrayPaths(records);
    if (paths.length === 0) {
      ExcelWorkbook.downloadExcel(rows, gridId);
      return;
    }
    // Parent: the ORIGINAL records kept intact (object arrays inline). No synthetic row-number
    // column — children reference the parent by its own key / sheet row position.
    const wb = XLSX.utils.table_to_book(ExcelView.createExcelTable(records, undefined, true));
    ExcelWorkbook.trimSheet(wb.Sheets[wb.SheetNames[0]]);
    ExcelWorkbook.styleSheet(wb.Sheets[wb.SheetNames[0]]);
    ExcelWorkbook.appendChildSheets(wb, records, paths, keyField, new Set(wb.SheetNames.map(n => n.toLowerCase())));
    XLSX.writeFile(wb, `everygrid_${gridId || 'export'}_${new Date().getTime()}.xlsx`);
  },
};
