/**
 * Web stand-in for mobile/app/src/lib/photoCapture.ts — the calls GLORIA
 * makes (`captureEnvPhoto`, `pickPhotos`).
 *
 * The camera is the browser's (`capture="environment"`), which hands back a
 * JPEG with whatever EXIF the phone writes; the file is stored as it came
 * (no re-encode, no restamping) in IndexedDB and referenced as
 * `webmedia:photos/<uuid>.jpg`. Phones without a camera input (desktop) get
 * the file chooser instead.
 */
import { putMedia } from './mediaStore';
import { chooseFiles } from './pickFiles';

export async function captureEnvPhoto(): Promise<string | null> {
  const [file] = await chooseFiles({ accept: 'image/jpeg,image/png', capture: 'environment' });
  return file ? putMedia('photos', file) : null;
}

export async function pickPhotos(): Promise<string[]> {
  const files = await chooseFiles({ accept: 'image/*', multiple: true });
  const out: string[] = [];
  for (const f of files) out.push(await putMedia('photos', f));
  return out;
}
