import React, {useState} from 'react';
import {I18n} from '../i18n/I18n';

interface PopupProps {
  onClose: () => void;
  title?: string;
  /** Muted line under the title, e.g. the file a config came from. */
  subtitle?: string;
  /** Hover text for the subtitle (e.g. the full URL when `subtitle` is just the file name). */
  subtitleTitle?: string;
  children: React.ReactNode;
  data?: unknown; // Add data prop for JSON view
  /**
   * Box size. `s` / `m` / `l` are fixed squares, so detail and text popups all open at the same
   * shape whatever they hold. `auto` is a content-height rectangle for popups with an action
   * footer (the editor), where a square wastes space and crowds the buttons.
   */
  size?: 's' | 'm' | 'l' | 'auto';
  /** Expand the box to fill the viewport (the caller owns the toggle; see MaximizeToggle). */
  maximized?: boolean;
  /** Render the MaximizeToggle in the header, next to the close button, and own its state. */
  maximizable?: boolean;
}

/** Icon button toggling a popup between its normal box and the viewport-filling one. */
export const MaximizeToggle = ({maximized, onToggle, className = ''}: {
  maximized: boolean;
  onToggle: () => void;
  className?: string;
}) => (
  <button
    type='button'
    className={`flex items-center justify-center self-stretch w-7 rounded bg-slate-200 text-slate-500 hover:text-slate-900 hover:bg-slate-300 transition-colors ${className}`}
    title={maximized ? 'Restore' : 'Maximize'}
    onClick={onToggle}
  >
    {/* Expand: arrows pushing out of the corners. Restore: arrows pulling back in. */}
    <svg width='16' height='16' viewBox='0 0 16 16' fill='none' stroke='currentColor' strokeWidth='1.6' strokeLinecap='round' strokeLinejoin='round'>
      {maximized
        ? <path d='M7 9v4M7 9H3M7 9l-4 4M9 7V3M9 7h4M9 7l4-4'/>
        : <path d='M2 6V2h4M2 2l4.5 4.5M14 10v4h-4M14 14l-4.5-4.5'/>}
    </svg>
  </button>
);

const PopupComponent: React.FC<PopupProps> = ({onClose, title, subtitle, subtitleTitle, children, data, size = 'm', maximized, maximizable}) => {
  const [viewMode, setViewMode] = useState<'table' | 'json'>('table');
  const [ownMaximized, setOwnMaximized] = useState(false);
  const isMax = maximized ?? ownMaximized;
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
      {/* The size class always stays: maximizing only overrides the width, so the box keeps the
          height its size asked for. */}
      <div className={`everygrid-popup-content everygrid-popup-${size}${isMax ? ' everygrid-popup-max' : ''}`}>
        <div className='everygrid-popup-header flex items-center justify-between'>
          <div className='flex items-center gap-4'>
            {title && <h3 className='m-0'>{title}</h3>}
            {/* Own row so the toggle stretches to the button group, not to the taller title. */}
            <div className='flex items-stretch gap-2'>
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
            {maximizable && <MaximizeToggle maximized={isMax} onToggle={() => setOwnMaximized((v) => !v)}/>}
            </div>
          </div>
          <span className='everygrid-popup-close' onClick={onClose}>&times;</span>
        </div>
        {subtitle && <div className='everygrid-popup-subtitle' title={subtitleTitle ?? subtitle}>{subtitle}</div>}
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
            <div className='flex flex-col min-h-full min-w-0'>
              {/* Its own row above the text, so it never sits on the first lines of the JSON. */}
              <div className='flex justify-end mb-2 shrink-0'>
                <button
                  type='button'
                  className={`everygrid-copy-btn${copied ? ' is-copied' : ''}`}
                  onClick={copyJson}
                  aria-label={I18n.t('popup.copy')}
                >
                  {I18n.t(copied ? 'popup.copied' : 'popup.copy')}
                </button>
              </div>
              {/* min-w-0 + w-full: a flex item's minimum width is its content, so a long line would
                  otherwise widen the pre past the popup and scroll the whole body sideways; the pre
                  scrolls on its own instead. */}
              <pre
                className='m-0 p-4 font-mono text-xs bg-slate-50 rounded border border-slate-200 overflow-auto flex-1 min-w-0 w-full'>
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
