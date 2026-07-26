import {I18n} from '../i18n/I18n';
import {Everygrid} from '../core/Everygrid';
import {isJsonString, parseIfJson} from '../core/utils';
import {highlightText, makeElementGate} from '../core/highlightUtils';
import {NestedTableComponent} from './NestedTableComponent';

export interface RowDetailProps<T extends Record<string, unknown>> {
  row: T;
  container: HTMLElement;
  grid: Everygrid<T>;
  onClose: () => void;
}

// Whole-row detail for the mobile layout: every column as a label/value pair, labels resolved through
// the same columnI18n the headers use. Nested values fall back to the shared NestedTableComponent.
export const RowDetailComponent = <T extends Record<string, unknown>>({
                                                                        row,
                                                                        container,
                                                                        grid,
                                                                        onClose,
                                                                      }: RowDetailProps<T>) => {
  const containerId = container.id;
  const fields = grid.getDataFields(containerId);
  // Live search text, so a match hidden behind the detail button is highlighted here too. The gate
  // is built over the whole row so column-scoped/correlated conditions resolve correctly per element.
  const filterText = grid.filterText || '';
  const elementGate = makeElementGate(row, filterText);

  const renderValue = (field: string) => {
    const raw = row[field];
    const val = isJsonString(raw) ? parseIfJson(raw) : raw;
    if (val !== null && typeof val === 'object') {
      return <NestedTableComponent data={val} depth={0} filterText={filterText} elementGate={elementGate}/>;
    }
    if (val === null || val === undefined || val === '') {
      return <span className='text-slate-300'>—</span>;
    }
    return <span>{highlightText(String(val), filterText, field)}</span>;
  };

  return (
    <div className={Everygrid.POPUP_OVERLAY_CLASS}>
      <div className={`${Everygrid.POPUP_CONTENT_CLASS} everygrid-popup-m`}>
        <div className='everygrid-popup-header'>
          <h3>{I18n.t('grid.rowDetail')}</h3>
          <span className={Everygrid.POPUP_CLOSE_CLASS} onClick={onClose}
                dangerouslySetInnerHTML={{__html: Everygrid.POPUP_CLOSE_HTML}}></span>
        </div>
        <div className='everygrid-popup-body flex-1'>
          <dl className='flex flex-col divide-y divide-slate-100'>
            {fields.map(field => (
              <div key={field} className='py-3'>
                <dt className='mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400'>
                  {grid.columnLabel(field, containerId)}
                </dt>
                <dd className='text-sm text-slate-700 break-words'>{renderValue(field)}</dd>
              </div>
            ))}
          </dl>
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
