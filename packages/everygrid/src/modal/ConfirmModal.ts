import {ModalBus} from './ModalBus';

export class ConfirmModal {
  public static show(message: string, onConfirm: () => void, onCancel: () => void) {
    ModalBus.emit({message, onConfirm, onCancel});
  }
}
