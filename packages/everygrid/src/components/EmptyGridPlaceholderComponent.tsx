import React from 'react';
import {I18n} from '../i18n/I18n';

interface EmptyGridPlaceholderProps {
  targetId: string;
  dataUrl?: string;
  /** While the grid is indexing, show a skeleton to fill the body instead of the "no data" message. */
  indexing?: boolean;
}

export const EmptyGridPlaceholder: React.FC<EmptyGridPlaceholderProps> = ({targetId, dataUrl, indexing}) => {
  if (indexing) {
    return (
      <div className="w-full h-full p-3 flex flex-col gap-2 overflow-hidden" aria-hidden="true">
        <div className="h-8 bg-slate-100 rounded animate-pulse shrink-0" />
        {Array.from({length: 10}).map((_, i) => (
          <div key={i} className="h-6 bg-slate-50 rounded animate-pulse shrink-0" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center text-slate-400 bg-slate-50/30">
      <span className="text-sm font-medium italic">{I18n.t('grid.noData')}</span>
      <div className="flex flex-col gap-1 text-[10px] text-slate-400 mt-2">
        <p>{I18n.t('grid.targetId')}: <span className="font-mono text-slate-500">{targetId}</span></p>
        <p>{I18n.t('grid.dataPath')}: <span
          className="font-mono text-slate-500">{dataUrl || I18n.t('grid.notSpecified')}</span></p>
      </div>
      <p className="text-xs mt-2">{I18n.t('grid.checkConfig')}</p>
    </div>
  );
};
