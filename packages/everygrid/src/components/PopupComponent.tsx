import React, {useState} from 'react';
import {I18n} from '../i18n/I18n';

interface PopupProps {
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  data?: unknown; // Add data prop for JSON view
  /**
   * Box size. `s` / `m` / `l` are fixed squares, so detail and text popups all open at the same
   * shape whatever they hold. `auto` is a content-height rectangle for popups with an action
   * footer (the editor), where a square wastes space and crowds the buttons.
   */
  size?: 's' | 'm' | 'l' | 'auto';
}

const PopupComponent: React.FC<PopupProps> = ({onClose, title, children, data, size = 'm'}) => {
  const [viewMode, setViewMode] = useState<'table' | 'json'>('table');
  const [copied, setCopied] = useState(false);
  const copyJson = () => {
    void navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // If data is a string and looks like XML, we might want to show it as is or formatted
  const isXml = typeof data === 'string' && data.trim().startsWith('<') && data.trim().endsWith('>') && data.includes('</');

  return (
    <div className='everygrid-popup-overlay'>
      <div className={`everygrid-popup-content everygrid-popup-${size}`}>
        <div className='everygrid-popup-header flex items-center justify-between'>
          <div className='flex items-center gap-4'>
            {title && <h3 className='m-0'>{title}</h3>}
            {(data !== undefined && !isXml) && (
              <div className='flex bg-slate-100 p-0.5 rounded text-[10px] font-bold'>
                <button
                  className={`px-3 py-1 rounded-sm transition-colors ${viewMode === 'table' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                  onClick={() => setViewMode('table')}
                >
                  {I18n.t('popup.tableView')}
                </button>
                <button
                  className={`px-3 py-1 rounded-sm transition-colors ${viewMode === 'json' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                  onClick={() => setViewMode('json')}
                >
                  {I18n.t('popup.jsonView')}
                </button>
              </div>
            )}
          </div>
          <span className='everygrid-popup-close' onClick={onClose}>&times;</span>
        </div>
        <div className='everygrid-popup-body everygrid-popup-code-body overflow-auto flex-1'>
          {viewMode === 'table' ? (
            isXml ? (
              <pre
                className='m-0 p-4 font-mono text-xs bg-slate-50 rounded border border-slate-200 overflow-auto max-h-full min-h-full whitespace-pre-wrap break-all'>
                {data as string}
              </pre>
            ) : (
              children
            )
          ) : (
            <div className='relative min-h-full'>
              <button
                type='button'
                className={`everygrid-copy-btn${copied ? ' is-copied' : ''}`}
                onClick={copyJson}
                aria-label={I18n.t('popup.copy')}
              >
                {I18n.t(copied ? 'popup.copied' : 'popup.copy')}
              </button>
              <pre
                className='m-0 p-4 font-mono text-xs bg-slate-50 rounded border border-slate-200 overflow-auto max-h-full min-h-full'>
                {JSON.stringify(data, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export { PopupComponent };
