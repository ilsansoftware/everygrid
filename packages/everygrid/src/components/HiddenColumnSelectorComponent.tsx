import {useState} from 'react';
import {I18n} from '../i18n/I18n';
import {Everygrid} from '../core/Everygrid';

export interface HiddenColumnSelectorProps<T extends Record<string, unknown>> {
  container: HTMLElement;
  grid: Everygrid<T>;
  onClose: () => void;
}

export const HiddenColumnSelectorComponent = <T extends Record<string, unknown>>({
                                                                                   container,
                                                                                   grid,
                                                                                   onClose,
                                                                                 }: HiddenColumnSelectorProps<T>) => {
  const containerId = container.id;
  const initialHidden = Array.from(grid.hiddenFieldsMap.get(containerId) || new Set<string>());
  const [hiddenFields, setHiddenFields] = useState<string[]>(initialHidden);

  const handleRemove = (field: string) => {
    const hiddenSet = grid.hiddenFieldsMap.get(containerId);
    if (hiddenSet) {
      hiddenSet.delete(field);
      grid.hiddenFieldsMap.set(containerId, hiddenSet);
    }
    const newHidden = hiddenFields.filter(f => f !== field);
    setHiddenFields(newHidden);
    grid.renderGrid(container);
  };

  const handleShowAll = () => {
    const hiddenSet = grid.hiddenFieldsMap.get(containerId);
    if (hiddenSet) {
      hiddenSet.clear();
      grid.hiddenFieldsMap.set(containerId, hiddenSet);
    }
    setHiddenFields([]);
    grid.renderGrid(container);
    onClose();
  };

  return (
    <div className={Everygrid.POPUP_OVERLAY_CLASS}>
      <div className={`${Everygrid.POPUP_CONTENT_CLASS} everygrid-popup-s`}>
        <div className="everygrid-popup-header">
          <h3>{I18n.t('grid.hiddenColumns').replace(' ({count})', '')}</h3>
          <span className={Everygrid.POPUP_CLOSE_CLASS} onClick={onClose}
                dangerouslySetInnerHTML={{__html: Everygrid.POPUP_CLOSE_HTML}}></span>
        </div>
        <div className="everygrid-popup-body flex-1">
          <div className="flex flex-col gap-1">
            {hiddenFields.map(field => (
              <div key={field}
                   className="flex items-center justify-between p-2 hover:bg-slate-50 rounded border border-slate-100">
                <span className="text-sm text-slate-700 font-medium">{field}</span>
                <button
                  className="px-2 py-1 bg-indigo-50 text-indigo-600 text-xs font-semibold rounded hover:bg-indigo-100 transition-colors"
                  onClick={() => handleRemove(field)}
                >
                  {I18n.t('grid.unhide')}
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="p-3 border-t border-slate-100 flex justify-between bg-white">
          <button
            className="text-xs text-indigo-600 hover:underline font-semibold"
            onClick={handleShowAll}
          >
            {I18n.t('grid.showAllColumns')}
          </button>
          <button
            className="px-4 py-1.5 bg-slate-800 text-white text-xs font-semibold rounded"
            onClick={onClose}
          >
            {I18n.t('popup.close')}
          </button>
        </div>
      </div>
    </div>
  );
};
