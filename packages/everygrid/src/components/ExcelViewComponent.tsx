import React, {useEffect, useRef} from 'react';
import {ExcelView} from '../core/ExcelView';
import {I18n} from '../i18n/I18n';
import {InfoIcon} from '../icons/InfoIcon';

export interface ExcelViewProps {
  data: unknown[];
  limit?: number;
  isExcel?: boolean;
}

export const ExcelViewComponent = ({data, limit, isExcel = false}: ExcelViewProps) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.innerHTML = '';
      containerRef.current.appendChild(ExcelView.createExcelTable(data, limit, isExcel));
    }
  }, [data, limit, isExcel]);

  return <div ref={containerRef} className='everygrid-excel-wrapper'/>;
};

export const ExcelViewWrapperComponent = <T extends Record<string, unknown>>({
                                                                               data,
                                                                               toolbar,
                                                                             }: {
  data: T[],
  toolbar: React.ReactNode,
}) => {
  const LIMIT = 50;
  const isLimited = data.length > LIMIT;

  return (
    <div className='everygrid-wrapper'>
      {toolbar}
      {isLimited && (
        <div
          className='m-4 p-3 bg-blue-50 border border-blue-200 text-blue-700 text-sm rounded-md flex items-center justify-between'>
          <div className='flex items-center'>
            {React.createElement(InfoIcon, {})}
            <span>{I18n.t('grid.limitInfo', {limit: LIMIT, total: data.length})}</span>
          </div>
        </div>
      )}
      <div className='everygrid-table-container overscroll-x-none'>
        <ExcelViewComponent data={data} limit={LIMIT} isExcel={true}/>
      </div>
    </div>
  );
};
