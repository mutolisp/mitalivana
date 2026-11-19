/**
 * `expo-document-picker` → a file input. A picked file is registered under a
 * `webpick:<n>` URI, which the expo-file-system shims read (`new File(uri)
 * .bytes()`, `readAsStringAsync`), so mobile code that picks then reads works
 * unchanged.
 */
const picked = new Map<string, File>();
let seq = 0;

export function registerPicked(file: File): string {
  const uri = `webpick:${++seq}/${encodeURIComponent(file.name)}`;
  picked.set(uri, file);
  return uri;
}

export function pickedFile(uri: string): File | null {
  return picked.get(uri) ?? null;
}

export type DocumentPickerAsset = { uri: string; name: string; mimeType?: string; size?: number; lastModified?: number; file?: File };
export type DocumentPickerResult = { canceled: true; assets: null } | { canceled: false; assets: DocumentPickerAsset[] };

export function getDocumentAsync(opts: { type?: string | string[]; multiple?: boolean; copyToCacheDirectory?: boolean } = {}): Promise<DocumentPickerResult> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    const types = (Array.isArray(opts.type) ? opts.type : opts.type ? [opts.type] : []).filter((t) => t !== '*/*');
    // '*/*' anywhere means "anything": no filter (iOS greys out files otherwise).
    const any = !opts.type || (Array.isArray(opts.type) ? opts.type.includes('*/*') : opts.type === '*/*');
    if (!any && types.length) input.accept = types.join(',');
    input.multiple = !!opts.multiple;
    input.style.display = 'none';
    let done = false;
    const finish = (r: DocumentPickerResult) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(r);
    };
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) return finish({ canceled: true, assets: null });
      finish({
        canceled: false,
        assets: files.map((f) => ({ uri: registerPicked(f), name: f.name, mimeType: f.type, size: f.size, lastModified: f.lastModified, file: f })),
      });
    });
    input.addEventListener('cancel', () => finish({ canceled: true, assets: null }));
    document.body.appendChild(input);
    input.click();
  });
}
