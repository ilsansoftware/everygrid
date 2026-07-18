import React, {type JSX, useEffect, useMemo, useState} from 'react';
import type {GridColumn, IEverygrid} from '../core/types';
import {I18n} from '../i18n/I18n';
import {EditIcon} from '../icons/EditIcon';
import {formatIsoTimestamp, getSummaryLabel, isJsonString, isXmlString} from '../core/utils';
import {highlightText, objectContainsFilter} from '../core/highlightUtils';


export interface TableCellProps<T extends Record<string, unknown>> {
  grid: IEverygrid<T>;
  col: GridColumn;
  item: T;
  rowIndex: number;
  containerId: string;
  container: HTMLElement;
  editableFields?: string[];
  filterText?: string;
}

export const TableCellComponent = React.memo(<T extends Record<string, unknown>>(
  {
    grid,
    col,
    item,
    rowIndex,
    containerId,
    container,
    editableFields = [],
    filterText = '',
  }: TableCellProps<T>) => {
  const isRowCheckbox = col.type === 'row_checkbox';
  const isIndexCol = col.field === I18n.t('grid.index');

  const isNumeric = useMemo(() => grid.isColumnNumeric(col.field), [grid, col.field]);
  const isDate = useMemo(() => grid.isColumnDate(col.field), [grid, col.field]);
  const isModified = useMemo(() => grid.isCellModified(item, col.field), [grid, item, col.field]);

  const [editValue, setEditValue] = useState<string>(String(item[col.field] ?? ''));
  const [isFocused, setIsFocused] = React.useState(false);
  const [showReset, setShowReset] = React.useState(false);

  useEffect(() => {
    if (!isFocused) {
      setEditValue(String(item[col.field] ?? ''));
    }
  }, [item, col.field, isFocused]);

  if (col.type === 'data_checkbox') {
    const mappingField = col.mapping ?? col.field;
    const value = item[mappingField];
    const checkedSet = grid.checkedValues?.get(containerId);
    const checked = checkedSet ? checkedSet.has(value) : false;
    return (
      <td className="text-center bg-slate-50/30 w-10">
        <input
          type="checkbox"
          className="cursor-pointer"
          checked={checked}
          onChange={(e) => {
            if (!grid.checkedValues) return;
            const set = grid.checkedValues.get(containerId) ?? new Set();
            if (e.target.checked) set.add(value);
            else set.delete(value);
            grid.checkedValues.set(containerId, set);
            grid.renderGrid(container);
          }}
        />
      </td>
    );
  }

  if (isRowCheckbox) {
    const isSelected = grid.getSelectedRows(containerId)?.has(item);
    return (
      <td className="text-center bg-slate-50/30 w-10">
        <input
          type="checkbox"
          className="cursor-pointer"
          checked={isSelected}
          onChange={(e) => {
            const selected = grid.getSelectedRows(containerId) || new Set();
            if (e.target.checked) selected.add(item);
            else selected.delete(item);
            grid.setSelectedRows(containerId, selected);
            grid.renderGrid(container);
            if (grid.options.onSelectionChange) {
              grid.options.onSelectionChange(Array.from(selected) as T[]);
            }
          }}
        />
      </td>
    );
  }

  if (isIndexCol) {
    return (
      <td className="bg-slate-50/50 font-medium text-center whitespace-pre overflow-hidden w-12.5 min-w-0">
        <div className="px-2">{rowIndex + 1}</div>
      </td>
    );
  }

  const handleCellClick = (e: React.MouseEvent) => {
    // Ignore cell click event when the reset button is clicked
    if ((e.target as HTMLElement).closest('.everygrid-cell-reset-btn')) {
      return;
    }

    if (grid.options.onCellClick) {
      grid.options.onCellClick(item, col.field);
    }
  };

  const renderValue = () => {
    const isEditableField = editableFields.includes(col.field);
    const activeEdits = grid.activeEditFields.get(containerId) || new Set();
    const isEditing = isEditableField && activeEdits.has(col.field);

    // Use JSON editor if column type is object, current value is object, value is a JSON string, or any row in the column has an object/JSON value
    const isObjectColumn = col.type === 'object' || typeof value === 'object' || isJsonString(value) || grid.isColumnObject(col.field);

    if (isEditing) {
      if (isObjectColumn) {
        if (value !== null && typeof value === 'object') {
          return (
            <div className="flex items-center justify-between gap-2 group/edit">
              <div className="flex-1 overflow-hidden">
                <button
                  className="everygrid-popup-btn text-[10px] py-0.5 px-1 bg-slate-100 hover:bg-slate-200 border-slate-300"
                  onClick={(e) => {
                    e.stopPropagation();
                    grid.showPopup?.(value, item);
                  }}
                >
                  {getSummaryLabel(value)}
                </button>
              </div>
              <button
                className="everygrid-cell-edit-btn w-5 h-5 shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  grid.showEditPopup(item, col.field, value);
                }}
                title={I18n.t('grid.edit')}
              >
                <EditIcon/>
              </button>
            </div>
          );
        } else {
          // value is primitive but isObjectColumn is true (because col.type is object or other rows have objects)
          return (
            <div className="flex items-center justify-between gap-2 group/edit">
              <div className="flex-1 overflow-hidden truncate">
                {value === null || value === undefined ? '' : String(value)}
              </div>
              <button
                className="everygrid-cell-edit-btn w-5 h-5 shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  grid.showEditPopup(item, col.field, value);
                }}
                title={I18n.t('grid.edit')}
              >
                <EditIcon/>
              </button>
            </div>
          );
        }
      }

      const isBoolean = typeof value === 'boolean' || col.type === 'boolean';

      if (isBoolean) {
        return (
          <div className={`flex items-center ${alignRight ? 'justify-end' : ''}`}>
            <select
              className="w-full px-1 py-0.5 text-sm border border-blue-400 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
              value={String(value)}
              onChange={(e) => {
                const val = e.target.value;
                const newVal = (val === 'true');
                grid.updateData(item, col.field, newVal);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  (e.target as HTMLSelectElement).blur();
                } else if (e.key === 'Escape') {
                  (e.target as HTMLSelectElement).blur();
                }
              }}
              autoFocus
              onClick={(e) => e.stopPropagation()}
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>
        );
      }

      let inputType = 'text';
      if (col.type === 'number' || typeof value === 'number') {
        inputType = 'number';
      } else if (col.type === 'date') {
        inputType = 'date';
      } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
        inputType = 'date';
      }

      return (
        <input
          type={inputType}
          className="w-full px-1 py-0.5 text-sm border border-blue-400 rounded focus:outline-none focus:ring-1 focus:ring-blue-400"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onFocus={() => setIsFocused(true)}
          onBlur={() => {
            setIsFocused(false);
            let finalValue: unknown = editValue;
            if (editValue === '') {
              finalValue = null;
            } else if (inputType === 'number') {
              finalValue = Number(editValue);
            }
            grid.updateData(item, col.field, finalValue as T[keyof T]);
          }}
          autoFocus
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              setIsFocused(false);
              setEditValue(String(value ?? ''));
              setTimeout(() => (e.target as HTMLInputElement).blur(), 0);
            }
          }}
        />
      );
    }

    if (value === null || value === undefined) return (
      <div className={`flex items-center gap-2 ${alignRight ? 'justify-end' : 'justify-between'}`}>
        <span></span>
      </div>
    );

    const renderObjectButton = (obj: object) => (
      <div className="flex items-center justify-between gap-2">
        <div className="flex-1 overflow-hidden">
          <button
            className={`everygrid-popup-btn text-[10px] py-0.5 px-1 bg-slate-100 hover:bg-slate-200 border-slate-300${filterText && objectContainsFilter(obj, filterText, col.field) ? ' everygrid-highlight-btn' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              grid.showPopup?.(obj, item);
            }}
          >
            {getSummaryLabel(obj)}
          </button>
        </div>
      </div>
    );

    if (typeof value === 'object') {
      return renderObjectButton(value);
    }

    // Even if the value is not an object, attempt to parse it as a JSON string
    if (typeof value === 'string') {
      if (isJsonString(value)) {
        try {
          const parsed = JSON.parse(value);
          return renderObjectButton(parsed);
        } catch (_e) {
          // Ignore and render as plain string
        }
      } else if (isXmlString(value)) {
        return (
          <div className="flex items-center justify-between gap-2">
            <span className="truncate opacity-80" title={value}>{highlightText(value, filterText, col.field)}</span>
          </div>
        );
      }
    }

    let displayValue = typeof value === 'string' ? formatIsoTimestamp(value) : String(value);
    const isLinkActive = grid.linkFields.has(col.field);
    const isEmail = typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

    if (grid.commaSeparatedFields.has(col.field)) {
      const numValue = Number(value);
      if (!isNaN(numValue) && typeof value !== 'boolean' && value !== '' && value !== null) {
        displayValue = numValue.toLocaleString();
      }
    }

    const renderLink = (text: string) => {
      const href = isEmail ? `mailto:${text}` : text.startsWith('http') ? text : `https://${text}`;
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="everygrid-link"
          onClick={(e) => e.stopPropagation()}
        >
          {highlightText(text, filterText, col.field)}
        </a>
      );
    };
    const hasNewLine = /[\r\n\u2028\u2029]/.test(displayValue);

    // Long or multi-line plain text: show a prefix as a button; clicking opens the full text in a
    // popup. Applies to any long string cell, not just object/JSON values. Links keep rendering inline.
    const LONG_TEXT_THRESHOLD = 100;
    const isLongText = !isLinkActive && (hasNewLine || displayValue.length > LONG_TEXT_THRESHOLD);
    if (isLongText) {
      const firstLine = displayValue.split(/[\r\n\u2028\u2029]/)[0];
      const prefix = firstLine.length > 60 ? `${firstLine.slice(0, 60)}\u2026` : (displayValue.length > firstLine.length ? `${firstLine}\u2026` : firstLine);
      return (
        <div className={`flex ${alignRight ? 'justify-end' : isCenter ? 'justify-center' : 'text-left'}`}>
          <button
            className="everygrid-popup-btn text-[10px] py-0.5 px-1 bg-slate-100 hover:bg-slate-200 border-slate-300 truncate max-w-full"
            onClick={(e) => { e.stopPropagation(); grid.showTextPopup?.(displayValue, item); }}
            title={displayValue}
          >
            {highlightText(prefix, filterText, col.field)}
          </button>
        </div>
      );
    }
    return (
      <div
        className={`flex gap-2 ${alignRight ? 'justify-end' : isCenter ? 'justify-center' : 'text-left'}`}>
        <span className="truncate">
          {isLinkActive && typeof value === 'string' && value.trim() !== '' ? renderLink(displayValue) : highlightText(displayValue, filterText, col.field)}
        </span>
      </div>
    );
  };

  const value = item[col.field];
  const alignRight = isNumeric || isDate;
  const isCenter = !alignRight && col.type !== 'row_checkbox';
  return (
    <td
      key={col.field}
      className={`px-2 py-2 text-sm overflow-hidden min-w-0 ${isModified ? 'is-modified group' : ''} ${alignRight ? 'text-right' : isCenter ? 'text-center' : ''}`}
      onClick={handleCellClick}
    >
      {isModified && (
        <>
          <div
            className="modified-marker"
            onClick={(e) => {
              e.stopPropagation();
              setShowReset(!showReset);
            }}
            title={I18n.t('grid.resetCell')}
          />
          {showReset && (
            <button
              className="everygrid-cell-reset-btn"
              onClick={(e) => {
                e.stopPropagation();
                grid.resetCell(item, col.field, container);
                setShowReset(false);
              }}
            >
              {I18n.t('grid.reset')}
            </button>
          )}
        </>
      )}
      {renderValue()}
    </td>
  );
}) as <T extends Record<string, unknown>>(props: TableCellProps<T>) => JSX.Element;
