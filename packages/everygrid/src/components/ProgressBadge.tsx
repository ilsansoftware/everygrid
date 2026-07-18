// Shared progress pill (spinner + text). Rendered in the toolbar's search slot while the grid is
// indexing, processing a filter/sort, or exporting.
export const ProgressBadge = ({text}: {text: string}) => (
  <div className="flex flex-1 min-w-0 max-w-96 items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-3 py-1.5 shadow-sm">
    <div className="w-3.5 h-3.5 border-2 border-slate-300 border-t-indigo-500 rounded-full animate-spin shrink-0" />
    <span className="text-[11px] font-medium text-slate-600 truncate">{text}</span>
  </div>
);
