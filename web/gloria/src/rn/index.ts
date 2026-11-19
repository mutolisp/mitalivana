/**
 * The `react-native` module as the web app provides it. Shared mobile UI
 * files (SHARED_UI in vite/mobileBridge.ts) import this in place of
 * react-native; web screens import it directly.
 */
export * from './core';
export * from './api';
export { StyleSheet } from './style';
export type { StyleProp } from './style';
export { Modal } from './Modal';
export type { ModalProps } from './Modal';
