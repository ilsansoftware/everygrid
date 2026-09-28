import {useEffect, useRef, useState} from 'react';
import {I18n} from '../i18n/I18n';
import { MaximizeToggle, PopupComponent } from './PopupComponent';

/**
 * Sanitizes a JSON-like string by replacing non-standard values like Infinity and NaN with their string equivalents.
 */
const sanitizeJsonString = (val: string): string => {
  return val.replace(/:\s*(-?Infinity|NaN)\b/g, ': "$1"')
    .replace(/\[\s*(-?Infinity|NaN)\b/g, '["$1"')
    .replace(/,\s*(-?Infinity|NaN)\b/g, ', "$1"');
};

type Path = (string | number)[];

/** Immutable set/delete at a path inside a JSON tree. */
const setAt = (root: unknown, path: Path, val: unknown, del = false): unknown => {
  if (path.length === 0) return val;
  const [k, ...rest] = path;
  if (Array.isArray(root)) {
    const a = [...root];
    if (rest.length === 0 && del) a.splice(k as number, 1);
    else a[k as number] = setAt(a[k as number], rest, val, del);
    return a;
  }
  const o = {...(root as Record<string, unknown>)};
  if (rest.length === 0 && del) delete o[k as string];
  else o[k as string] = setAt(o[k as string], rest, val, del);
  return o;
};

/** Renames a key inside the object at `path`, keeping entry order. */
const renameAt = (root: unknown, path: Path, from: string, to: string): unknown => {
  const obj = path.reduce<unknown>((n, k) => (n as Record<string, unknown>)[k as string], root) as Record<string, unknown>;
  if (to === from || to in obj) return root;
  const next = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k === from ? to : k, v]));
  return setAt(root, path, next);
};

const primitiveToText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v) ?? '');
/** Anything that parses as JSON becomes that value — numbers, booleans, null, and `{}` / `[]` /
 * full objects, which then unfold into a nested table; anything else stays a string. */
const textToValue = (t: string): unknown => {
  try {
    return JSON.parse(t);
  } catch (_e) {
    return t;
  }
};

/** A text input that commits on blur / Enter, so partial input like "1." is not re-parsed mid-typing. */
const CommitInput = ({value, className, placeholder, onCommit}: {
  value: string;
  className?: string;
  placeholder?: string;
  onCommit: (v: string) => void;
}) => (
  <input
    className={className}
    placeholder={placeholder}
    defaultValue={value}
    onBlur={(e) => { if (e.target.value !== value) onCommit(e.target.value); }}
    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
  />
);

/** Recursive key/value table over a JSON tree; objects and arrays nest inline. */
const JsonTableNode = ({data, path, onChange}: {
  data: unknown;
  path: Path;
  onChange: (next: (root: unknown) => unknown) => void;
}) => {
  if (data === null || typeof data !== 'object') {
    return (
      <CommitInput
        key={primitiveToText(data)}
        className='everygrid-json-table-value'
        placeholder='{} or [] + Enter'
        value={primitiveToText(data)}
        onCommit={(t) => onChange((root) => {
          let v = textToValue(t);
          // An empty container is seeded with one entry, as if "+" had been pressed right away.
          if (Array.isArray(v) && v.length === 0) v = [''];
          else if (v !== null && typeof v === 'object' && Object.keys(v).length === 0) v = {key1: ''};
          return setAt(root, path, v);
        })}
      />
    );
  }
  const isArray = Array.isArray(data);
  const entries: [string | number, unknown][] = isArray
    ? (data as unknown[]).map((v, i) => [i, v])
    : Object.entries(data as Record<string, unknown>);
  const add = () => onChange((root) => {
    if (isArray) return setAt(root, [...path, entries.length], '');
    let i = entries.length + 1;
    while (`key${i}` in (data as Record<string, unknown>)) i++;
    return setAt(root, [...path, `key${i}`], '');
  });
  return (
    <table className='everygrid-json-table'>
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k}>
            <td className='everygrid-json-table-key'>
              {isArray
                ? <span className='px-1 text-slate-400'>{k}</span>
                : <CommitInput
                    key={k}
                    value={String(k)}
                    onCommit={(t) => onChange((root) => renameAt(root, path, String(k), t))}
                  />}
            </td>
            <td><JsonTableNode data={v} path={[...path, k]} onChange={onChange}/></td>
            <td className='everygrid-json-table-del'>
              <button type='button' title='Remove' onClick={() => onChange((root) => setAt(root, [...path, k], undefined, true))}>×</button>
            </td>
          </tr>
        ))}
        <tr>
          <td colSpan={3} className='everygrid-json-table-add'>
            <button type='button' onClick={add}>+</button>
          </td>
        </tr>
      </tbody>
    </table>
  );
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
  const initialText = data === null || data === undefined ? '' : (typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  const [value, setValue] = useState(initialText);
  const [mode, setMode] = useState<'text' | 'json' | 'table'>(typeof data === 'object' && data !== null ? 'table' : 'text');
  /** Parsed tree the TABLE mode edits; kept in sync with `value` so switching modes never loses edits. */
  const [tree, setTree] = useState<unknown>(typeof data === 'object' ? data : null);

  const [error, setError] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const caretTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(caretTimer.current), []);

  const handleSave = () => {
    const rawValue = value.trim();
    let updatedData: unknown = rawValue;

    if (mode === 'table') {
      updatedData = tree;
    } else if (mode === 'json') {
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

  /** Back to the cell's current value, in whatever mode is showing. */
  const handleReset = () => {
    setValue(initialText);
    setTree(typeof data === 'object' ? data : null);
    setError(null);
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
    <PopupComponent onClose={onClose} title={I18n.t('popup.textEditorTitle', {field})} size='auto' maximized={maximized}>
      <div className='px-4 py-2 border-b border-slate-100 flex items-center gap-4 bg-slate-50/50'>
        <div className='flex bg-slate-200 p-0.5 rounded text-[10px] font-bold'>
          <button
            className={`px-3 py-1 rounded-sm transition-colors ${mode === 'table' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            onClick={() => {
              try {
                const parsed = JSON.parse(sanitizeJsonString(value.trim() || '{}'));
                if (parsed === null || typeof parsed !== 'object') throw new Error();
                setTree(parsed);
                setMode('table');
                setError(null);
              } catch (_e) {
                setError(I18n.t('popup.invalidJson'));
              }
            }}
          >
            TABLE
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
          <button
            className={`px-3 py-1 rounded-sm transition-colors ${mode === 'text' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            onClick={() => {
              setMode('text');
              setError(null);
            }}
          >
            TEXT
          </button>
        </div>
        <MaximizeToggle className='-ml-2' maximized={maximized} onToggle={() => setMaximized((v) => !v)}/>
      </div>
      {mode === 'table' ? (
        <div className='everygrid-json-table-wrap'>
          <JsonTableNode
            data={tree}
            path={[]}
            onChange={(next) => {
              const updated = next(tree);
              setTree(updated);
              setValue(JSON.stringify(updated, null, 2));
            }}
          />
        </div>
      ) : (
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

            clearTimeout(caretTimer.current);
            caretTimer.current = setTimeout(() => {
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
      )}
      {error && (
        <div className='px-4 py-1 text-xs text-red-500 bg-red-50 border-t border-red-100'>
          {error}
        </div>
      )}
      <div className='everygrid-popup-footer'>
        <button
          className='px-3 py-1.5 font-medium text-xs bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors border border-slate-200 rounded disabled:opacity-50 disabled:cursor-not-allowed'
          disabled={value === initialText}
          onClick={handleReset}
        >
          {I18n.t('popup.reset')}
        </button>
        <button
          className='px-3 py-1.5 font-medium text-xs bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors border border-slate-200 rounded'
          hidden={mode === 'table'}
          onClick={handleFormat}
        >
          {I18n.t('popup.format') || 'Format'}
        </button>
        <button
          className='px-4 py-2 font-medium text-sm bg-slate-900 text-white hover:bg-slate-800 transition-colors rounded'
          onClick={handleSave}
        >
          {I18n.t('popup.apply')}
        </button>
      </div>
    </PopupComponent>
  );
};
