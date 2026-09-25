/**
 * Share a generated file, then delete it. Exports, backups and labels are
 * written to the cache only to be handed to the share sheet; left there they
 * piled up (timestamped photo backups especially) and counted toward the
 * app's size in iOS settings.
 *
 * The delete waits a little after the sheet closes: a target may still be
 * copying the file (AirDrop, Save to Files) when the promise resolves.
 */
import * as Sharing from 'expo-sharing';
import { File } from 'expo-file-system';

const GRACE_MS = 30_000;

export async function shareThenDelete(uri: string, options?: Parameters<typeof Sharing.shareAsync>[1]): Promise<void> {
  try {
    await Sharing.shareAsync(uri, options);
  } finally {
    setTimeout(() => {
      try {
        const f = new File(uri);
        if (f.exists) f.delete();
      } catch {
        // Already gone, or still held open: the storage page's cache clear gets it.
      }
    }, GRACE_MS);
  }
}
