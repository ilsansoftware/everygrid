import {I18n} from '../i18n/I18n';

// Shared progress pill (spinner + text). Rendered in the toolbar's search slot while the grid is
// indexing, processing a filter/sort, or exporting. When `onCancel` is given (abortable worker
// export only), a "Cancel" action is shown on the right.
export const ProgressBadge = ({text, onCancel}: {text: string; onCancel?: () => void}) => (
  <div className="flex flex-1 min-w-0 max-w-96 items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-3 py-1.5 shadow-sm">
    <div className="w-3.5 h-3.5 border-2 border-slate-300 border-t-indigo-500 rounded-full animate-spin shrink-0" />
    <span className="text-[11px] font-medium text-slate-600 truncate">{text}</span>
    {onCancel && (
      <button
        type="button"
        onClick={onCancel}
        className="ml-auto shrink-0 text-[11px] font-medium text-slate-400 hover:text-red-500"
      >{I18n.t('popup.cancel')}</button>
    )}
  </div>
);
