import {useRef, useState} from 'react';
import {I18n} from '../i18n/I18n';
import { PopupComponent } from './PopupComponent';

/**
 * Sanitizes a JSON-like string by replacing non-standard values like Infinity and NaN with their string equivalents.
 */
const sanitizeJsonString = (val: string): string => {
  return val.replace(/:\s*(-?Infinity|NaN)\b/g, ': "$1"')
    .replace(/\[\s*(-?Infinity|NaN)\b/g, '["$1"')
    .replace(/,\s*(-?Infinity|NaN)\b/g, ', "$1"');
};

export const TextEditorPopupComponent = ({
                                           field,
                                           data,
                                           onClose,
                                           onSave
                                         }: {
  field: string;
  data: unknown;
  onClose: () => void;
  onSave: (data: unknown) => void;
}) => {
  const [value, setValue] = useState(data === null || data === undefined ? '' : (typeof data === 'string' ? data : JSON.stringify(data, null, 2)));
  const [mode, setMode] = useState<'text' | 'json'>(typeof data === 'object' && data !== null ? 'json' : 'text');

  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSave = () => {
    const rawValue = value.trim();
    let updatedData: unknown = rawValue;

    if (mode === 'json') {
      try {
        // Support non-standard JSON values like Infinity and NaN by converting them to null
        const sanitized = sanitizeJsonString(rawValue);
        updatedData = JSON.parse(sanitized);
      } catch (_e) {
        setError(I18n.t('popup.invalidJson'));
        return;
      }
    }

    onSave(updatedData);
  };

  const handleFormat = () => {
    try {
      const sanitized = sanitizeJsonString(value);
      const parsed = JSON.parse(sanitized);
      setValue(JSON.stringify(parsed, null, 2));
      setError(null);
    } catch (_e) {
      setError(I18n.t('popup.invalidJson'));
    }
  };

  return (
    <PopupComponent onClose={onClose} title={I18n.t('popup.textEditorTitle', {field})} size="auto">
      <div className="px-4 py-2 border-b border-slate-100 flex items-center gap-4 bg-slate-50/50">
        <div className="flex bg-slate-200 p-0.5 rounded text-[10px] font-bold">
          <button
            className={`px-3 py-1 rounded-sm transition-colors ${mode === 'text' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            onClick={() => {
              setMode('text');
              setError(null);
            }}
          >
            TEXT
          </button>
          <button
            className={`px-3 py-1 rounded-sm transition-colors ${mode === 'json' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            onClick={() => {
              setMode('json');
              const val = value.trim();
              try {
                if (val) {
                  const sanitized = sanitizeJsonString(val);
                  JSON.parse(sanitized);
                }
                setError(null);
              } catch (_e) {
                setError(I18n.t('popup.invalidJson'));
              }
            }}
          >
            JSON
          </button>
        </div>
      </div>
      <textarea
        ref={textareaRef}
        className={`everygrid-text-editor ${error ? 'border-red-500' : ''}`}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (mode === 'json') {
            const val = e.target.value.trim();
            try {
              if (val) {
                const sanitized = sanitizeJsonString(val);
                JSON.parse(sanitized);
              }
              setError(null);
            } catch (_e) {
              setError(I18n.t('popup.invalidJson'));
            }
          } else {
            setError(null);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Tab') {
            e.preventDefault();
            const start = e.currentTarget.selectionStart;
            const end = e.currentTarget.selectionEnd;
            const newValue = value.substring(0, start) + '  ' + value.substring(end);
            setValue(newValue);

            setTimeout(() => {
              if (textareaRef.current) {
                textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start + 2;
              }
            }, 0);
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleSave();
          }
        }}
        placeholder=''
      />
      {error && (
        <div className="px-4 py-1 text-xs text-red-500 bg-red-50 border-t border-red-100">
          {error}
        </div>
      )}
      <div className="everygrid-popup-footer">
        <button
          className="px-3 py-1.5 font-medium text-xs bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors border border-slate-200 rounded"
          onClick={handleFormat}
        >
          {I18n.t('popup.format') || 'Format'}
        </button>
        <button
          className="px-4 py-2 font-medium text-sm bg-slate-900 text-white hover:bg-slate-800 transition-colors rounded"
          onClick={handleSave}
        >
          {I18n.t('popup.apply')}
        </button>
      </div>
    </PopupComponent>
  );
};
