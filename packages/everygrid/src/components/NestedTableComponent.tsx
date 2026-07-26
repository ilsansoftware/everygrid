import React from 'react';
import {getSummaryLabel, isTooComplex, isXmlString} from '../core/utils';
import {highlightText} from '../core/highlightUtils';

interface NestedTableProps {
  data: unknown;
  depth?: number;
  onShowPopup?: () => void;
  filterText?: string;
  // Correlation-aware gate: returns the part of the query that holds for an element ('' = none).
  // Built once at the popup root (over the whole row) and threaded down so a condition only
  // highlights inside the element it actually matched.
  elementGate?: (el: unknown) => string;
}

const NestedTableInner: React.FC<NestedTableProps> = ({data, depth = 0, onShowPopup, filterText = '', elementGate}) => {
  if (depth > 0 && onShowPopup && isTooComplex(data)) {
    const label = getSummaryLabel(data);

    return (
      <button
        className='everygrid-popup-btn text-[10px] py-0.5 px-1 bg-slate-100 hover:bg-slate-200 border-slate-300'
        onClick={(e) => {
          e.stopPropagation();
          onShowPopup();
        }}
      >
        {label}
      </button>
    );
  }

  if (depth > 2 && onShowPopup) {
    return <button className='everygrid-popup-btn' onClick={onShowPopup}>View Details</button>;
  }

  // Element-scoped highlight: each element is highlighted with the sub-query that matched IT, so a
  // sibling condition (`subRole(back).years(=4)`) doesn't bleed onto other elements — and neither
  // does the other side of an `||` that this element didn't satisfy.
  const gate = elementGate ?? ((): string => filterText);
  const elFilter = (el: unknown): string => (filterText ? gate(el) : '');

  if (Array.isArray(data)) {
    // A one-element array of an object reads better AS that object. The column-per-key layout below
    // needs several rows to earn its header row, and with one row it just turns every value into a
    // sliver of a column — worse the deeper the cell it sits in. Rendered through the inner
    // component so this doesn't add a second scroll wrapper around the same level.
    if (data.length === 1 && typeof data[0] === 'object' && data[0] !== null && !Array.isArray(data[0])) {
      return <NestedTableInner data={data[0]} depth={depth} onShowPopup={onShowPopup} filterText={filterText}
                               elementGate={elementGate}/>;
    }
    // Check if it's an array of objects with identical single key
    const isArrayOfSameSingleKeyObjects = data.length > 1 && data.every(item =>
      typeof item === 'object' && item !== null && Object.keys(item).length === 1
    );

    if (isArrayOfSameSingleKeyObjects) {
      const firstKey = Object.keys(data[0] as object)[0];
      const isAllSameKey = data.every(item => Object.keys(item as object)[0] === firstKey);

      if (isAllSameKey) {
        return (
          <table className='everygrid-nested-table'>
            <thead>
            <tr>
              <th>{highlightText(firstKey, filterText)}</th>
            </tr>
            </thead>
            <tbody>
            {data.map((item, rowIndex) => {
              const row = item as Record<string, unknown>;
              const cellVal = row[firstKey];
              const ef = elFilter(item);
              return (
                <tr key={rowIndex}>
                  <td>
                    {typeof cellVal === 'object' && cellVal !== null ? (
                      <NestedTableComponent data={cellVal} depth={depth + 1} filterText={ef} elementGate={elementGate}/>
                    ) : (
                      isXmlString(cellVal) ? (
                        <span className='opacity-80'
                              title={String(cellVal)}>{highlightText(String(cellVal), ef)}</span>
                      ) : (
                        highlightText(String(cellVal ?? ''), ef)
                      )
                    )}
                  </td>
                </tr>
              );
            })}
            </tbody>
          </table>
        );
      }
    }

    if (data.length > 0 && data.every(item => Array.isArray(item))) {
      // Array of arrays
      return (
        <table className='everygrid-nested-table'>
          <tbody>
          {data.map((rowItems, rowIndex) => {
            const ef = elFilter(rowItems);
            return (
            <tr key={rowIndex}>
              {(rowItems as unknown[]).map((val, colIndex) => (
                <td key={colIndex}>
                  {typeof val === 'object' && val !== null ? (
                    <NestedTableComponent data={val} depth={depth + 1} filterText={ef} elementGate={elementGate}/>
                  ) : (
                    isXmlString(val) ? (
                      <span className='opacity-80' title={String(val)}>{highlightText(String(val), ef)}</span>
                    ) : (
                      highlightText(String(val ?? ''), ef)
                    )
                  )}
                </td>
              ))}
            </tr>
          );
          })}
          </tbody>
        </table>
      );
    }

    // Check if array is mixed (contains both primitives/arrays and plain objects)
    const hasPrimitive = data.some(item => typeof item !== 'object' || item === null);
    const hasPlainObject = data.some(item => typeof item === 'object' && item !== null && !Array.isArray(item));
    const hasNestedArray = data.some(item => Array.isArray(item));
    const isMixed = (hasPrimitive || hasNestedArray) && hasPlainObject || (hasPrimitive && hasNestedArray);

    if (isMixed) {
      // Render each item separated by a divider line
      return (
        <table className='everygrid-nested-table w-full'>
          <tbody>
          {data.map((item, i) => {
            const ef = elFilter(item);
            return (
            <tr key={i}>
              {/* No hard-coded `p-0` here: a mixed list holds primitives too, and those need the
                  normal cell padding. A cell whose only child is a nested level drops its padding
                  through CSS instead (see `td:has(> .everygrid-nested-scroll)`). */}
              <td>
                {typeof item === 'object' && item !== null ? (
                  <NestedTableComponent data={item} depth={depth + 1} onShowPopup={onShowPopup} filterText={ef} elementGate={elementGate}/>
                ) : (
                  <span>{highlightText(String(item ?? ''), ef)}</span>
                )}
              </td>
            </tr>
          );
          })}
          </tbody>
        </table>
      );
    }

    // Array of objects
    const allKeys = new Set<string>();
    data.forEach(item => {
      if (typeof item === 'object' && item !== null) {
        Object.keys(item).forEach(key => allKeys.add(key));
      }
    });
    const keys = Array.from(allKeys);

    if (keys.length === 0) {
      return (
        <div className='whitespace-pre-wrap'>
          {data.map((item, i) => (
            <div key={i}>{highlightText(String(item ?? ''), filterText)}</div>
          ))}
        </div>
      );
    }

    return (
      <table className='everygrid-nested-table'>
        {keys.length > 0 && (
          <thead>
          <tr>
            {keys.map(key => (
              <th key={key}>{highlightText(key, filterText)}</th>
            ))}
          </tr>
          </thead>
        )}
        <tbody>
        {data.map((item, rowIndex) => {
          const ef = elFilter(item);
          return (
          <tr key={rowIndex}>
            {typeof item === 'object' && item !== null ? (
              keys.map(key => {
                const row = item as Record<string, unknown>;
                const cellVal = row[key];
                return (
                  <td key={key}>
                    {cellVal !== undefined ? (
                      typeof cellVal === 'object' && cellVal !== null ? (
                        <NestedTableComponent data={cellVal} depth={depth + 1} filterText={ef} elementGate={elementGate}/>
                      ) : (
                        isXmlString(cellVal) ? (
                          <span className='opacity-80'
                                title={String(cellVal)}>{highlightText(String(cellVal), ef)}</span>
                        ) : (
                          highlightText(String(cellVal ?? ''), ef)
                        )
                      )
                    ) : null}
                  </td>
                );
              })
            ) : (
              <td colSpan={keys.length || 1}>
                {highlightText(String(item ?? ''), ef)}
              </td>
            )}
          </tr>
          );
        })}
        </tbody>
      </table>
    );
  } else if (typeof data === 'object' && data !== null) {
    // Single object
    const entries = Object.entries(data);
    const isAllArrays = entries.every(([_, value]) => Array.isArray(value));

    if (isAllArrays && entries.length > 0) {
      // If all values are arrays, treat keys as columns
      const columnKeys = entries.map(([key]) => key);
      const maxRows = Math.max(...entries.map(([_, value]) => (value as unknown[]).length));
      const rows = Array.from({length: maxRows});

      return (
        <table className='everygrid-nested-table'>
          <thead>
          <tr>
            {columnKeys.map(key => <th key={key}>{highlightText(key, filterText)}</th>)}
          </tr>
          </thead>
          <tbody>
          {rows.map((_, rowIndex) => (
            <tr key={rowIndex}>
              {columnKeys.map(key => {
                const cellData = (data as Record<string, unknown[]>)[key][rowIndex];
                const ef = elFilter(cellData);
                return (
                  <td key={key}>
                    {cellData !== undefined ? (
                      typeof cellData === 'object' && cellData !== null ? (
                        <NestedTableComponent data={cellData} depth={depth + 1} filterText={ef} elementGate={elementGate}/>
                      ) : (
                        isXmlString(cellData) ? (
                          <span className='opacity-80' title={String(cellData)}>{highlightText(String(cellData), ef)}</span>
                        ) : (
                          highlightText(String(cellData ?? ''), ef)
                        )
                      )
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
          </tbody>
        </table>
      );
    }

    return (
      <table className='everygrid-nested-table'>
        <tbody>
        {Object.entries(data).map(([key, value]) => (
          <tr key={key}>
            <th>{highlightText(key, filterText)}</th>
            <td>
              {typeof value === 'object' && value !== null ? (
                <NestedTableComponent data={value} depth={depth + 1} filterText={filterText} elementGate={elementGate}/>
              ) : (
                isXmlString(value) ? (
                  <span className='opacity-80' title={String(value)}>{highlightText(String(value), filterText)}</span>
                ) : (
                  highlightText(String(value ?? ''), filterText)
                )
              )}
            </td>
          </tr>
        ))}
        </tbody>
      </table>
    );
  }

  return <span>{highlightText(String(data ?? ''), filterText)}</span>;
};

/* Every level below the top gets its own scroll box. A wide section then scrolls where it sits,
   instead of either widening the whole popup or being squeezed flat — and because the table inside
   keeps `min-width: 100%`, a narrow one still fills its cell rather than leaving a gap beside it. */
const NestedTableComponent: React.FC<NestedTableProps> = props => {
  const inner = <NestedTableInner {...props}/>;
  return (props.depth ?? 0) > 0 ? <div className='everygrid-nested-scroll'>{inner}</div> : inner;
};

export {NestedTableComponent};
