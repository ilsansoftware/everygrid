import React from 'react';

interface PrettyJSONProps {
  data: unknown;
}

const PrettyJSONComponent: React.FC<PrettyJSONProps> = ({data}) => {
  if (data === null) {
    return <span className="json-null">null</span>;
  }

  if (Array.isArray(data)) {
    if (data.length === 0) { return <span>[]</span>; }
    return (
      <>
        <span>[ </span>
        <ul className="json-array">
          {data.map((item, index) => (
            <li key={index}>
              <span className="json-value">
                <PrettyJSONComponent data={item}/>
              </span>
            </li>
          ))}
        </ul>
        <span> ]</span>
      </>
    );
  }

  if (typeof data === 'object') {
    const typedData = data as Record<string, unknown>;
    const keys = Object.keys(typedData);
    if (keys.length === 0) { return <span>{'{ }'}</span>; }
    return (
      <>
        <span>{'{ '}</span>
        <div className="json-object">
          {keys.map((key) => (
            <div key={key} className="json-item">
              <span className="json-key">{`"${key}": `}</span>
              <span className="json-value">
                <PrettyJSONComponent data={typedData[key]}/>
              </span>
            </div>
          ))}
        </div>
        <span> {'}'} </span>
      </>
    );
  }

  return (
    <span className={`json-${typeof data}`}>
      {typeof data === 'string' ? `"${data}"` : String(data)}
    </span>
  );
};

export { PrettyJSONComponent };
