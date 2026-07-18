import * as React from 'react';
import {I18n} from '../i18n/I18n';

export interface ConfirmModalProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  onClose: () => void;
}

export const ConfirmModalComponent: React.FC<ConfirmModalProps> = ({message, onConfirm, onCancel, onClose}) => {
  return (
    <div className="fixed inset-0 z-9999 flex items-center justify-center bg-slate-900/30">
      <div className="bg-white p-6 rounded shadow-lg w-80">
        <p className="mb-4 text-sm text-gray-700">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            className="px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
            onClick={() => {
              onClose();
              onCancel();
            }}
          >
            {I18n.t('popup.cancel')}
          </button>
          <button
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
            onClick={() => {
              onClose();
              onConfirm();
            }}
          >
            {I18n.t('popup.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
};
