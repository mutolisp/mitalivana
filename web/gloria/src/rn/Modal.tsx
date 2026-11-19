/**
 * RN <Modal>: a fixed full-viewport layer in a portal. `transparent` keeps
 * the page visible behind it; otherwise the modal paints the paper colour.
 * Escape (and the browser back gesture is not intercepted) calls
 * onRequestClose, like Android's back button.
 */
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type ModalProps = {
  visible?: boolean;
  transparent?: boolean;
  animationType?: 'none' | 'slide' | 'fade';
  presentationStyle?: string;
  onRequestClose?: () => void;
  onShow?: () => void;
  onDismiss?: () => void;
  statusBarTranslucent?: boolean;
  navigationBarTranslucent?: boolean;
  supportedOrientations?: string[];
  children?: ReactNode;
};

export function Modal(p: ModalProps) {
  const visible = p.visible !== false;
  useEffect(() => {
    if (!visible) return;
    p.onShow?.();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') p.onRequestClose?.();
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      p.onDismiss?.();
    };
    // Show / dismiss once per visibility change.
  }, [visible]);
  if (!visible) return null;
  return createPortal(
    <div
      className={[
        'rn-view fixed inset-0 z-40',
        p.transparent ? '' : 'bg-paper dark:bg-paper-dark',
        p.animationType === 'slide' ? 'rn-modal-slide' : p.animationType === 'fade' ? 'rn-modal-fade' : '',
      ].join(' ')}
      role="dialog"
      aria-modal="true"
    >
      {p.children}
    </div>,
    document.body,
  );
}
