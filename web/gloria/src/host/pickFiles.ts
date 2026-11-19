/**
 * Open the browser's file picker (or camera, with `capture`) and resolve with
 * the chosen files; an empty list when cancelled.
 */
export function chooseFiles(opts: { accept?: string; multiple?: boolean; capture?: 'environment' | 'user' } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (opts.accept) input.accept = opts.accept;
    input.multiple = !!opts.multiple;
    if (opts.capture) input.setAttribute('capture', opts.capture);
    input.style.display = 'none';
    let done = false;
    const finish = (files: File[]) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}
