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
          th.className = 'border-b border-r border-slate-200 bg-slate-50 p-2 text-xs font-semibold text-slate-700';
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
          th.className = 'border-b border-r border-slate-200 bg-slate-50 p-2 text-xs font-semibold text-slate-700';
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

    // Apply Excel styles (top alignment, word wrap)
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];

    for (const key in ws) {
      if (key.startsWith('!')) {
        continue;
      }
      if (!ws[key].s) ws[key].s = {};

      ws[key].s.alignment = {vertical: 'top', wrapText: true};
    }

    XLSX.writeFile(wb, fileName);
  },

  flattenObjectForExcel: (obj: unknown, prefix = ''): Record<string, unknown> => {
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
              flattened[propName] = value.map(item => {
                if (typeof item === 'object' && item !== null) {
                  const flat = ExcelView.flattenObjectForExcel(item);
                  if (Object.keys(flat).length === 0) {
                    return '{}';
                  }
                  return Object.entries(flat).map(([k, v]) => {
                    return `${k}: ${v === '' ? '""' : String(v)}`;
                  }).join('\n');
                }
                return item === '' ? '""' : item;
              }).join('\n');
            }
          }
        } else if (typeof value === 'object' && value !== null) {
          if (Object.keys(value).length === 0) {
            flattened[propName] = '{}';
          } else {
            const typedValue = value as Record<string, unknown>;
            const isComplex = Object.values(typedValue).some(v => typeof v === 'object' && v !== null);
            if (isComplex) {
              flattened[propName] = ExcelView.formatObject(value);
            } else {
              const nested = ExcelView.flattenObjectForExcel(value, propName);
              Object.assign(flattened, nested);
            }
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
    const MARKER = '  ';
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
        if (typeof item !== 'object' || item === null) {
          const val = String(item);
          return `${MARKER.repeat(indent)}${item === '' ? '""' : val}`;
        }
        if (Array.isArray(item) && item.length === 0) {
          return `${MARKER.repeat(indent)}[]`;
        }
        if (typeof item === 'object' && Object.keys(item).length === 0) {
          return `${MARKER.repeat(indent)}{}`;
        }
        return ExcelView.formatObject(item, indent);
      }).join('\n');
    }

    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) {
      return `${MARKER.repeat(indent)}{}`;
    }

    const isComplex = entries.some(([, v]) => typeof v === 'object' && v !== null && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0));

    if (isComplex) {
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
    } else {
      return `${MARKER.repeat(indent)}` + entries.map(([k, v]) => {
        const val = String(v);
        return `${k}: ${v === '' ? '""' : val}`;
      }).join(', ');
    }
  },

  getExcelRows: (data: unknown[]): Record<string, unknown>[] => {
    return data.map((item, originalIndex) => ({
      ...ExcelView.flattenObjectForExcel(item),
      _originalIndex: originalIndex
    }));
  }
};
