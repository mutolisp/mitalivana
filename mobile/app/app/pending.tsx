/**
 * 待鑑定 — the pending observations alone, for the pro and volunteer modes:
 * made in casual mode, they had no way back into view once the mode changed
 * (code review L59). The list itself is CasualHome's; a row opens 這是什麼？.
 */
import { CasualHome } from '~/components/casual/CasualHome';

export default function PendingScreen() {
  return <CasualHome pendingOnly />;
}
