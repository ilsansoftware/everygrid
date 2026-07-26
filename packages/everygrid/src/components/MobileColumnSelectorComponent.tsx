import {useEffect, useRef, useState} from 'react';
import {I18n} from '../i18n/I18n';
import {Everygrid} from '../core/Everygrid';

export interface MobileColumnSelectorProps<T extends Record<string, unknown>> {
  allFields: string[];
  container: HTMLElement;
  grid: Everygrid<T>;
  onClose: () => void;
}

// Pick which columns show on mobile. No cap — the row scrolls horizontally, so any number (up to
// all) can be selected. Selection order is the display order. Backed by the same `displayColsMap`
// as the desktop "Select Columns", so the choice is shared; an empty set falls back to config / all.
export const MobileColumnSelectorComponent = <T extends Record<string, unknown>>({
                                                                                   allFields,
                                                                                   container,
                                                                                   grid,
                                                                                   onClose,
                                                                                 }: MobileColumnSelectorProps<T>) => {
  const containerId = container.id;
  // Seed from the currently effective columns so the modal opens on what's on screen: the explicit
  // whitelist if one was set (an empty one means "deselect all"), else the configured mobile
  // defaults, else every column.
  const [selected, setSelected] = useState<Set<string>>(() => {
    if (grid.displayColsMap.has(containerId)) return new Set(grid.displayColsMap.get(containerId));
    const configured = grid.getMobileColumns(containerId)?.filter(f => allFields.includes(f));
    return new Set(configured && configured.length > 0 ? configured : allFields);
  });

  // An empty selection falls back to the first three columns, so the grid always keeps a sensible
  // default (never zero data columns) — including when "select all" is toggled off.
  const commit = (next: Set<string>) => {
    const eff = next.size > 0 ? next : new Set(allFields.slice(0, 3));
    setSelected(new Set(eff));
    grid.displayColsMap.set(containerId, new Set(eff));
    grid.renderGrid(container);
  };

  const handleToggle = (field: string) => {
    const next = new Set(selected);
    if (next.has(field)) next.delete(field); else next.add(field);
    commit(next);
  };

  const allSelected = allFields.length > 0 && allFields.every(f => selected.has(f));
  const someSelected = allFields.some(f => selected.has(f));
  // Native checkbox indeterminate (some-but-not-all) is DOM-only, so set it via a ref.
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected && !allSelected;
  }, [someSelected, allSelected]);

  return (
    <div className={Everygrid.POPUP_OVERLAY_CLASS}>
      <div className={`${Everygrid.POPUP_CONTENT_CLASS} everygrid-popup-s`}>
        <div className='everygrid-popup-header'>
          <h3>{I18n.t('toolbar.mobileColumns')}</h3>
          <span className={Everygrid.POPUP_CLOSE_CLASS} onClick={onClose}
                dangerouslySetInnerHTML={{__html: Everygrid.POPUP_CLOSE_HTML}}></span>
        </div>
        <div className='everygrid-popup-body flex-1'>
          <label className='mb-3 flex items-center gap-3 rounded-lg border border-slate-200 p-3 text-base cursor-pointer hover:bg-slate-50'>
            <input
              ref={selectAllRef}
              type='checkbox'
              className='h-5 w-5'
              checked={allSelected}
              onChange={() => commit(new Set(allSelected ? [] : allFields))}
            />
            <span className='flex-1 font-semibold text-slate-700'>{I18n.t('toolbar.selectAll')}</span>
          </label>
          <div className='flex flex-col gap-2'>
            {allFields.map(field => {
              const isOn = selected.has(field);
              return (
                <label key={field}
                       className={`flex items-center gap-3 rounded-lg border p-3 text-base cursor-pointer ${
                         isOn ? 'border-indigo-300 bg-indigo-50' : 'border-slate-200 hover:bg-slate-50'
                       }`}>
                  <input
                    type='checkbox'
                    className='h-5 w-5'
                    checked={isOn}
                    onChange={() => handleToggle(field)}
                  />
                  <span className='flex-1 text-slate-700'>{grid.columnLabel(field, containerId)}</span>
                </label>
              );
            })}
          </div>
        </div>
        <div className='flex justify-end border-t border-slate-100 p-3'>
          <button
            className='rounded-lg bg-slate-800 px-5 py-2.5 text-sm font-semibold text-white'
            onClick={onClose}
          >
            {I18n.t('popup.close')}
          </button>
        </div>
      </div>
    </div>
  );
};
