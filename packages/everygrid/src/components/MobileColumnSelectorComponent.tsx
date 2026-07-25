import {useState} from 'react';
import {I18n} from '../i18n/I18n';
import {Everygrid} from '../core/Everygrid';

export interface MobileColumnSelectorProps<T extends Record<string, unknown>> {
  allFields: string[];
  container: HTMLElement;
  grid: Everygrid<T>;
  onClose: () => void;
}

const MAX = 3;

// Pick up to 3 columns for the mobile (no-horizontal-scroll) layout. Selection order is the column
// order. Writing an empty set falls back to config / first-3; a non-empty set overrides both.
export const MobileColumnSelectorComponent = <T extends Record<string, unknown>>({
                                                                                   allFields,
                                                                                   container,
                                                                                   grid,
                                                                                   onClose,
                                                                                 }: MobileColumnSelectorProps<T>) => {
  const containerId = container.id;
  // Seed from the currently effective mobile columns so the modal opens on what's on screen.
  const [selected, setSelected] = useState<string[]>(
    grid.getMobileFields(containerId, allFields.map(f => ({headerName: f, field: f}))),
  );

  const commit = (next: string[]) => {
    setSelected(next);
    grid.mobileColsMap.set(containerId, new Set(next));
    grid.renderGrid(container);
  };

  const handleToggle = (field: string) => {
    if (selected.includes(field)) {
      commit(selected.filter(f => f !== field));
    } else if (selected.length < MAX) {
      commit([...selected, field]);
    }
  };

  return (
    <div className={Everygrid.POPUP_OVERLAY_CLASS}>
      <div className={`${Everygrid.POPUP_CONTENT_CLASS} everygrid-popup-s`}>
        <div className='everygrid-popup-header'>
          <h3>{I18n.t('toolbar.mobileColumns')}</h3>
          <span className={Everygrid.POPUP_CLOSE_CLASS} onClick={onClose}
                dangerouslySetInnerHTML={{__html: Everygrid.POPUP_CLOSE_HTML}}></span>
        </div>
        <div className='everygrid-popup-body flex-1'>
          <p className='mb-3 text-sm text-slate-500'>{I18n.t('grid.mobileColumnsHint', {max: String(MAX)})}</p>
          <div className='flex flex-col gap-2'>
            {allFields.map(field => {
              const order = selected.indexOf(field);
              const isOn = order !== -1;
              const atCap = !isOn && selected.length >= MAX;
              return (
                <label key={field}
                       className={`flex items-center gap-3 rounded-lg border p-3 text-base ${
                         isOn ? 'border-indigo-300 bg-indigo-50' : atCap ? 'border-slate-100 opacity-40' : 'border-slate-200 hover:bg-slate-50'
                       } ${atCap ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                  <input
                    type='checkbox'
                    className='h-5 w-5'
                    checked={isOn}
                    disabled={atCap}
                    onChange={() => handleToggle(field)}
                  />
                  <span className='flex-1 text-slate-700'>{grid.columnLabel(field, containerId)}</span>
                  {isOn && <span className='text-xs font-bold text-indigo-600'>{order + 1}</span>}
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
