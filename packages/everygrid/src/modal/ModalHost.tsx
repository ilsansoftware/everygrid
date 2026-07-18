import {useEffect, useState} from 'react';
import {ConfirmModalComponent} from './ConfirmModalView';
import type {ModalEvent} from './ModalBus';
import {ModalBus} from './ModalBus';

export const ModalHost = () => {
  const [data, setData] = useState<ModalEvent>(null);

  useEffect(() => {
    return ModalBus.subscribe(setData);
  }, []);

  if (!data) { return null; }

  return (
    <ConfirmModalComponent
      message={data.message}
      onConfirm={() => {
        data.onConfirm();
        setData(null);
      }}
      onCancel={() => {
        data.onCancel();
        setData(null);
      }}
      onClose={() => setData(null)}
    />
  );
};
