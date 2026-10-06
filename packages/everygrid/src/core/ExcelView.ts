import XLSX from 'xlsx-js-style';

// `dense: true` is supported at runtime (stores cells in a 2D array instead of one property per
// cell, avoiding V8's ~8.4M-property enumeration limit) but missing from this version's types.
const DENSE = {dense: true} as unknown as Parameters<typeof XLSX.utils.aoa_to_sheet>[1];

export const ExcelView = {
  createExcelTable: (data: unknown[], limit?: number, isExcel: boolean = false): HTMLTableElement => {
    if (!data || data.length === 0) {
      return document.createElement('table');
    }

    const displayData = limit ? data.slice(0, limit) : data;

    // 1. Convert data to Excel rows (including array expansion)
    const expandedRows = ExcelView.getExcelRows(displayData);

    // 2. Collect all possible leaf paths (data columns)
    const allKeys = new Set<string>();
    expandedRows.forEach(row => Object.keys(row).forEach(k => allKeys.add(k)));

    // Build field order map from all data
    const fieldOrderMap = new Map<string, number>();
    let orderCounter = 0;

    const collectOrder = (obj: unknown, prefix = '') => {
      if (!obj || typeof obj !== 'object') {
        return;
      }

      if (Array.isArray(obj)) {
        obj.forEach(item => collectOrder(item, prefix));
        return;
      }

      const typedObj = obj as Record<string, unknown>;
      for (const key in typedObj) {
        const fullKey = prefix ? `${prefix}_${key}` : key;
        if (!fieldOrderMap.has(fullKey)) {
          fieldOrderMap.set(fullKey, orderCounter++);
        }

        const val = typedObj[key];
        if (val && typeof val === 'object') {
          collectOrder(val, fullKey);
        }
      }
    };

    data.forEach(item => collectOrder(item));

    const rawPaths = Array.from(allKeys);
    const leafPaths = rawPaths.filter(p => {
      if (p === '_originalIndex') {
        return false;
      }
      if (p === 'Index') {
        return true;
      }
      const hasChildren = rawPaths.some(other => other.startsWith(p + '_'));
      return !hasChildren;
    });

    const sortedPaths = leafPaths.sort((a, b) => {
      const aParts = a.split('_');
      const bParts = b.split('_');
      const minLen = Math.min(aParts.length, bParts.length);

      for (let i = 0; i < minLen; i++) {
        const aPath = aParts.slice(0, i + 1).join('_');
        const bPath = bParts.slice(0, i + 1).join('_');

        if (aPath !== bPath) {
          const aOrder = fieldOrderMap.has(aPath) ? fieldOrderMap.get(aPath)! : Infinity;
          const bOrder = fieldOrderMap.has(bPath) ? fieldOrderMap.get(bPath)! : Infinity;

          if (aOrder !== bOrder) {
            return aOrder - bOrder;
          }
          return aPath.localeCompare(bPath);
        }
      }
      return aParts.length - bParts.length;
    });

    // 3. Create table
    const table = document.createElement('table');
    table.className = 'everygrid-table excel-format-table';

    // 4. Create multi-line header
    const maxDepth = Math.max(...sortedPaths.map(p => p.split('_').length));
    const thead = document.createElement('thead');

    for (let d = 0; d < maxDepth; d++) {
      const tr = document.createElement('tr');
      for (let i = 0; i < sortedPaths.length; i++) {
        const path = sortedPaths[i];
        const parts = path.split('_');
        const label = parts[d] || '';

        // Check columns with the same parent/label (colspan)
        let colspan = 1;
        if (label !== '') {
          for (let j = i + 1; j < sortedPaths.length; j++) {
            const nextParts = sortedPaths[j].split('_');
            const nextLabel = nextParts[d] || '';
            const sameParent = parts.slice(0, d).join('_') === nextParts.slice(0, d).join('_');
            if (label === nextLabel && sameParent) {
              colspan++;
            } else {
              break;
            }
          }
        }

        if (colspan > 1) {
          const th = document.createElement('th');
          th.innerHTML = label.replace(/\n/g, '<br>');
          th.colSpan = colspan;
          th.className = 'border-b border-r border-line bg-slate-50 p-2 text-xs font-semibold text-slate-700';
          if (isExcel) {
            th.style.whiteSpace = 'pre-wrap';
            th.style.verticalAlign = 'top';
            th.style.setProperty('mso-data-placement', 'same-cell');
          }
          tr.appendChild(th);
          i += (colspan - 1);
        } else {
          const th = document.createElement('th');
          th.innerHTML = label.replace(/\n/g, '<br>');
          th.className = 'border-b border-r border-line bg-slate-50 p-2 text-xs font-semibold text-slate-700';
          if (isExcel) {
            th.style.whiteSpace = 'pre-wrap';
            th.style.verticalAlign = 'top';
            th.style.setProperty('mso-data-placement', 'same-cell');
          }

          // Rowspan handling: expand downward if this is the last part
          if (d === parts.length - 1 && d < maxDepth - 1) {
            th.rowSpan = maxDepth - d;
          } else if (label === '') {
            // If label is empty, the previous th already covered it with rowspan.
            continue;
          }

          tr.appendChild(th);
        }
      }
      thead.appendChild(tr);
    }
    table.appendChild(thead);

    // 5. Create body
    const tbody = document.createElement('tbody');

    // State variables for merging the Index column
    let lastIndexValue: number | null = null;
    let indexTdToMerge: HTMLTableCellElement | null = null;
    let indexRowSpan = 1;

    expandedRows.forEach((row, rowIndex) => {
      const tr = document.createElement('tr');
      tr.className = rowIndex % 2 === 0 ? 'bg-white' : 'bg-slate-50/30';

      const currentIndexValue = (row['_originalIndex'] as number) + 1;

      for (let i = 0; i < sortedPaths.length; i++) {
        const path = sortedPaths[i];

        if (path === 'Index') {
          if (lastIndexValue === currentIndexValue && indexTdToMerge) {
            indexRowSpan++;
            indexTdToMerge.rowSpan = indexRowSpan;
            continue; // Skip the Index cell for the current row
          } else {
            const td = document.createElement('td');
            td.className = 'border-b border-r border-slate-100 p-2 text-xs text-slate-600 whitespace-nowrap bg-slate-50/50 font-medium text-center';
            if (isExcel) {
              td.style.whiteSpace = 'pre-wrap';
              td.style.verticalAlign = 'top';
              td.style.setProperty('mso-data-placement', 'same-cell');
            }
            td.textContent = String(currentIndexValue);
            tr.appendChild(td);

            // Update state
            lastIndexValue = currentIndexValue;
            indexTdToMerge = td;
            indexRowSpan = 1;
            continue;
          }
        }

        const td = document.createElement('td');
        td.className = 'border-b border-r border-slate-100 p-2 text-xs text-slate-600 whitespace-pre';
        if (isExcel) {
          td.style.whiteSpace = 'pre';
          td.style.verticalAlign = 'top';
          td.style.setProperty('mso-data-placement', 'same-cell');
        }

        const value = row[path];
        const displayValue = (value === undefined || value === null) ? '' : String(value);

        // Escape XML strings to prevent tags from being interpreted as HTML
        // Since innerHTML is used to render <br>, < and > in data must be escaped
        const escapedValue = displayValue
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');

        td.innerHTML = escapedValue.replace(/\n/g, '<br>');
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    return table;
  },

  // Small / empty fallback: the rich DOM-table path (array expansion, merged cells). Large
  // exports are handled off-thread by the export worker (see Everygrid.exportExcel).
  downloadExcel: (data: unknown[], gridId?: string) => {
    const table = ExcelView.createExcelTable(data, undefined, true);
    ExcelView.downloadTableAsExcel(table, gridId);
  },

  // Column order: union of keys across rows, preserving first-seen order. Used by the worker.
  unionHeader: (flatRows: Record<string, unknown>[]): string[] => {
    const header: string[] = [];
    const seen = new Set<string>();
    for (const row of flatRows) {
      for (const key of Object.keys(row)) {
        if (!seen.has(key)) { seen.add(key); header.push(key); }
      }
    }
    return header;
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
      const ws = ExcelView.sheetFromRows(s.rows, true, s.front || []);
      if (ws) XLSX.utils.book_append_sheet(wb, ws, ExcelView.sanitizeSheetName(s.name, used));
    }
    if (wb.SheetNames.length === 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Sheet1');
    const out = XLSX.write(wb, {type: 'array', bookType: 'xlsx', compression: true} as XLSX.WritingOptions);
    return new Uint8Array(out as ArrayBuffer);
  },

  // Trigger a browser download of raw bytes (main thread only).
  triggerDownload: (bytes: Uint8Array, fileName: string, mime: string) => {
    const blob = new Blob([bytes as unknown as BlobPart], {type: mime});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  downloadTableAsExcel: (table: HTMLTableElement, gridId?: string) => {
    const fileName = `everygrid_${gridId || 'export'}_${new Date().getTime()}.xlsx`;
    const wb = XLSX.utils.table_to_book(table);
    ExcelView.trimSheet(wb.Sheets[wb.SheetNames[0]]);
    ExcelView.styleSheet(wb.Sheets[wb.SheetNames[0]]);
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

  // Excel sheet-name rules: <=31 chars, none of \ / ? * [ ] :, unique within a book.
  sanitizeSheetName: (name: string, used: Set<string>): string => {
    const base = (name.replace(/[\\/?*[\]:]/g, '_').slice(0, 31)) || 'Sheet';
    let candidate = base;
    let n = 1;
    while (used.has(candidate.toLowerCase())) {
      const suffix = `_${n++}`;
      candidate = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  },

  // Paths (as key arrays) to every non-empty array in the record tree, at ANY object depth — the
  // one-to-many relations that become normalized child sheets (object AND scalar arrays; scalar
  // elements land in a `_value` column). Walks through plain objects but does NOT descend into an
  // array's elements (single-level normalization). Key arrays (not '_'-joined strings) so keys
  // containing '_' stay unambiguous. Union across rows, first-appearance order.
  arrayPaths: (rows: Record<string, unknown>[]): string[][] => {
    const paths: string[][] = [];
    const seen = new Set<string>();
    const walk = (obj: unknown, prefix: string[]) => {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
      for (const [key, v] of Object.entries(obj as Record<string, unknown>)) {
        const path = [...prefix, key];
        if (Array.isArray(v)) {
          if (v.length > 0) {
            const id = JSON.stringify(path);
            if (!seen.has(id)) { seen.add(id); paths.push(path); }
          }
        } else if (v && typeof v === 'object') {
          walk(v, path);
        }
      }
    };
    for (const row of rows) walk(row, []);
    return paths;
  },

  getAtPath: (obj: unknown, path: string[]): unknown =>
    path.reduce((o, k) => (o && typeof o === 'object') ? (o as Record<string, unknown>)[k] : undefined, obj),

  // Decompose a structured field value into child-sheet rows (EAV-style): EVERY sub-key becomes a
  // row keyed by `_key` (its sub-path), scalars go to `_value`, object elements are flattened into
  // columns, and array position is `_idx`. So {a:'Korean', b:'English', c:['Korean','Japanese']}
  // yields rows for a, b AND each element of c — not just the array — so the whole column is usable.
  // `scalarAsKey`: when the field value is itself a bare scalar, put it in `_key` (the field is
  // "keyed" — it appears as a keyed object elsewhere, e.g. role) instead of `_value` (a plain
  // value list, e.g. language). Only affects the top-level scalar case.
  decomposeToRows: (value: unknown, keyPrefix: string, out: Record<string, unknown>[], scalarAsKey = false) => {
    if (Array.isArray(value)) {
      value.forEach((el, idx) => {
        const base: Record<string, unknown> = keyPrefix ? {_key: keyPrefix, _idx: idx} : {_idx: idx};
        if (el && typeof el === 'object' && !Array.isArray(el)) {
          out.push({...base, ...ExcelView.flattenObjectForExcel(el, '', true)});
        } else {
          out.push({...base, _value: Array.isArray(el) ? JSON.stringify(el) : el});
        }
      });
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const key = keyPrefix ? `${keyPrefix}_${k}` : k;
        if (v && typeof v === 'object') {
          ExcelView.decomposeToRows(v, key, out);
        } else {
          out.push({_key: key, _value: v});
        }
      }
    } else if (value !== undefined && value !== null) {
      // The field value is itself a scalar (a column that is an object/array in some rows but a
      // plain value in others) — still emit one row so every record is represented. Route it to
      // `_key` or `_value` per scalarAsKey (see above).
      out.push(scalarAsKey ? {_key: value} : {_value: value});
    }
  },

  // Best-effort parent key when no checkbox mapping is configured: an id-like top-level field.
  detectKeyField: (record: unknown): string | undefined => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
    const keys = Object.keys(record as Record<string, unknown>);
    return keys.find(k => /^(id|_id|uuid|guid|key|code|no)$/i.test(k)) ?? keys.find(k => /id$/i.test(k));
  },

  // Reorder a header so `front` columns (that exist) lead, in the given order; the rest keep theirs.
  orderHeader: (header: string[], front: string[]): string[] => {
    const set = new Set(front);
    return [...front.filter(f => header.includes(f)), ...header.filter(h => !set.has(h))];
  },

  // Build a worksheet from row objects (DOM-free): union header (with `front` columns pulled to the
  // left) + (optionally dense) aoa, trimmed and styled. Returns null for an empty row set.
  sheetFromRows: (rows: Record<string, unknown>[], dense = false, front: string[] = []): XLSX.WorkSheet | null => {
    if (rows.length === 0) return null;
    const header = ExcelView.orderHeader(ExcelView.unionHeader(rows), front);
    const aoa = rows.map(row => header.map(k => { const v = row[k]; return v === undefined ? '' : v; }));
    const ws = XLSX.utils.aoa_to_sheet([header, ...aoa], dense ? DENSE : undefined);
    ExcelView.trimSheet(ws);
    ExcelView.styleSheet(ws);
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
      const ws = ExcelView.sheetFromRows(childRows, dense, ['_mainSheetRowNum', '_idx']);
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
      ExcelView.downloadExcel(rows, gridId);
      return;
    }
    // Parent: the ORIGINAL records kept intact (object arrays inline). No synthetic row-number
    // column — children reference the parent by its own key / sheet row position.
    const wb = XLSX.utils.table_to_book(ExcelView.createExcelTable(records, undefined, true));
    ExcelView.trimSheet(wb.Sheets[wb.SheetNames[0]]);
    ExcelView.styleSheet(wb.Sheets[wb.SheetNames[0]]);
    ExcelView.appendChildSheets(wb, records, paths, keyField, new Set(wb.SheetNames.map(n => n.toLowerCase())));
    XLSX.writeFile(wb, `everygrid_${gridId || 'export'}_${new Date().getTime()}.xlsx`);
  },


  // `deep`: when true, nested objects are flattened into `parent_child` columns to ANY depth
  // (used by child sheets, the analysis surface). When false (main sheet / preview) every nested
  // object is instead collapsed into one formatObject cell, so it reads the same as an object
  // array. Object arrays are one cell either way (single-level normalization).
  flattenObjectForExcel: (obj: unknown, prefix = '', deep = false): Record<string, unknown> => {
    const flattened: Record<string, unknown> = {};
    if (obj === null || obj === undefined) {
      return flattened;
    }
    if (typeof obj !== 'object') {
      if (prefix) flattened[prefix] = obj;
      return flattened;
    }
    const typedObj = obj as Record<string, unknown>;
    for (const key in typedObj) {
      if (Object.prototype.hasOwnProperty.call(typedObj, key)) {
        const propName = prefix ? `${prefix}_${key}` : key;
        const value = typedObj[key];
        if (Array.isArray(value)) {
          if (value.length === 0) {
            flattened[propName] = '[]';
          } else {
            const isSimpleArray = value.every(item => typeof item !== 'object' || item === null);
            if (isSimpleArray) {
              flattened[propName] = value.map(item => item === '' ? '""' : String(item)).join(', ');
            } else {
              // Array of objects → the shared YAML-list renderer, so it looks identical whether the
              // array sits at the top level (here) or nested under a complex object (via formatObject).
              flattened[propName] = ExcelView.formatObject(value);
            }
          }
        } else if (typeof value === 'object' && value !== null) {
          if (Object.keys(value).length === 0) {
            flattened[propName] = '{}';
          } else if (!deep) {
            // Main sheet / preview: a nested object is ONE column, its contents rendered into the
            // single cell — the same treatment object arrays get, so every nested value reads the
            // same way. (It used to split an all-scalar object like {name,division,headcount} into
            // parent_child columns while an object holding arrays stayed one cell — same data,
            // two shapes.) Child sheets pass deep=true and still flatten fully, for analysis.
            flattened[propName] = ExcelView.formatObject(value);
          } else {
            const nested = ExcelView.flattenObjectForExcel(value, propName, deep);
            Object.assign(flattened, nested);
          }
        } else {
          flattened[propName] = value;
        }
      }
    }
    return flattened;
  },

  formatObject: (obj: unknown, indent = 0): string => {
    // Indent with non-breaking spaces (U+00A0): preserved in the pre-wrap preview AND in the
    // .xlsx cell value (not an ASCII space, so nothing trims/collapses it), and — unlike the old
    // '_ ' marker — it renders as clean whitespace that can't be mistaken for real data.
    const MARKER = '\u00A0\u00A0';
    if (obj === null || obj === undefined) {
      return 'null';
    }
    if (typeof obj !== 'object') {
      const val = String(obj);
      return obj === '' ? '""' : val;
    }

    if (Array.isArray(obj)) {
      if (obj.length === 0) {
        return `${MARKER.repeat(indent)}[]`;
      }
      if (obj.every(item => typeof item !== 'object' || item === null)) {
        return `${MARKER.repeat(indent)}${obj.map(item => {
          const val = String(item);
          return item === '' ? '""' : val;
        }).join(', ')}`;
      }
      return obj.map(item => {
        // YAML list style: each element starts with a "- " bullet so element boundaries are clear.
        const dash = `${MARKER.repeat(indent)}-\u00A0`;
        if (typeof item !== 'object' || item === null) {
          const val = String(item);
          return `${dash}${item === '' ? '""' : val}`;
        }
        if (Array.isArray(item) && item.length === 0) {
          return `${dash}[]`;
        }
        if (typeof item === 'object' && Object.keys(item).length === 0) {
          return `${dash}{}`;
        }
        // Render the element one level deeper, then swap its first line's indent for the bullet so
        // its fields line up under the dash.
        const rendered = ExcelView.formatObject(item, indent + 1);
        return dash + rendered.slice(MARKER.repeat(indent + 1).length);
      }).join('\n');
    }

    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) {
      return `${MARKER.repeat(indent)}{}`;
    }

    // One "key: value" per line at every depth — flat objects included — so a nested object never
    // collapses onto a single comma-joined line (which was hard to read for multi-field records).
    const lines: string[] = [];
    for (const [key, value] of entries) {
      if (typeof value === 'object' && value !== null) {
        if (Array.isArray(value)) {
          if (value.length === 0) {
            lines.push(`${MARKER.repeat(indent)}${key}: []`);
          } else if (value.every(v => typeof v !== 'object' || v === null)) {
            lines.push(`${MARKER.repeat(indent)}${key}: ${value.map(v => v === '' ? '""' : String(v)).join(', ')}`);
          } else {
            lines.push(`${MARKER.repeat(indent)}${key}\n${ExcelView.formatObject(value, indent + 1)}`);
          }
        } else if (Object.keys(value).length === 0) {
          lines.push(`${MARKER.repeat(indent)}${key}: {}`);
        } else {
          lines.push(`${MARKER.repeat(indent)}${key}\n${ExcelView.formatObject(value, indent + 1)}`);
        }
      } else {
        const val = String(value);
        lines.push(`${MARKER.repeat(indent)}${key}: ${value === '' ? '""' : val}`);
      }
    }
    return lines.join('\n');
  },

  getExcelRows: (data: unknown[]): Record<string, unknown>[] => {
    return data.map((item, originalIndex) => ({
      ...ExcelView.flattenObjectForExcel(item),
      _originalIndex: originalIndex
    }));
  }
};
