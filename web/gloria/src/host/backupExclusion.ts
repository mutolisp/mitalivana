/** Web stand-in for mobile/app/modules/backup-exclusion: there is no OS backup to opt out of. */
export function excludeFromBackup(_uri: string): boolean {
  return false;
}
