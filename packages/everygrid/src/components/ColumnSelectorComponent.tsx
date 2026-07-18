import {useState} from 'react';
import {I18n} from '../i18n/I18n';
import {Everygrid} from '../core/Everygrid';

export interface ColumnSelectorProps<T extends Record<string, unknown>> {
  allFields: string[];
  container: HTMLElement;
  grid: Everygrid<T>;
  onClose: () => void;
}

// Column display whitelist. Default: everything unchecked = show all columns. Check some columns
// and only those are shown. Backed by grid.displayColsMap (separate from the hide-columns list).
export const ColumnSelectorComponent = <T extends Record<string, unknown>>({
                                                                             allFields,
                                                                             container,
                                                                             grid,
                                                                             onClose,
                                                                           }: ColumnSelectorProps<T>) => {
  const containerId = container.id;
  const [selected, setSelected] = useState<Set<string>>(new Set(grid.displayColsMap.get(containerId) || []));

  const handleToggle = (field: string) => {
    const set = grid.displayColsMap.get(containerId) || new Set<string>();
    if (set.has(field)) {
      set.delete(field);
    } else {
      set.add(field);
    }
    grid.displayColsMap.set(containerId, set);
    setSelected(new Set(set));
    grid.renderGrid(container);
  };

  return (
    <div className={Everygrid.POPUP_OVERLAY_CLASS}>
      <div className={`${Everygrid.POPUP_CONTENT_CLASS}`}>
        <div className="everygrid-popup-header">
          <h3>{I18n.t('toolbar.selectColumns')}</h3>
          <span className={Everygrid.POPUP_CLOSE_CLASS} onClick={onClose}
                dangerouslySetInnerHTML={{__html: Everygrid.POPUP_CLOSE_HTML}}></span>
        </div>
        <div className="everygrid-popup-body p-6">
          <div className="flex flex-col gap-2">
            {allFields.map(field => (
              <label key={field} className="flex items-center gap-2 cursor-pointer hover:bg-slate-50 p-1 rounded">
                <input
                  type="checkbox"
                  checked={selected.has(field)}
                  onChange={() => handleToggle(field)}
                />
                <span className="text-sm text-slate-700">{field}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
