export type ModalEvent = {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
} | null;

const listeners: ((event: ModalEvent) => void)[] = [];

export const ModalBus = {
  emit: (event: ModalEvent) => {
    listeners.forEach((listener) => listener(event));
  },
  subscribe: (listener: (event: ModalEvent) => void) => {
    listeners.push(listener);
    return () => {
      const index = listeners.indexOf(listener);
      if (index > -1) listeners.splice(index, 1);
    };
  }
};
