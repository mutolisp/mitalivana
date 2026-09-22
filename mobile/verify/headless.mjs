/**
 * Run `verify.html`'s real script under Node, so the third verifier is checked
 * rather than merely written.
 *
 * Everything that page actually does — parsing the zip with
 * `DecompressionStream`, hashing with `crypto.subtle`, verifying with the
 * inlined noble-ed25519 — is a web standard Node implements too. What is NOT
 * checked here is layout, styling, and the file-picker plumbing; those need a
 * browser and are in `mobile/Device_test.md`.
 *
 * The script is driven the way a person drives it: a fake drop event carrying
 * the zip. Calling an internal function instead would test a seam that does
 * not exist on the page.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/** Just enough DOM for the page's own code — no library, no jsdom. */
function makeDom() {
  const mk = (tag) => {
    const node = {
      tagName: tag,
      className: '',
      _text: '',
      children: [],
      style: {},
      classList: { add() {}, remove() {} },
      listeners: {},
      get textContent() {
        return this._text;
      },
      set textContent(v) {
        this._text = String(v);
        this.children = [];
      },
      append(...kids) {
        for (const k of kids) this.children.push(k);
      },
      replaceChildren(...kids) {
        this.children = kids;
        this._text = '';
      },
      addEventListener(name, fn) {
        this.listeners[name] = fn;
      },
      get lastChild() {
        return this.children[this.children.length - 1];
      },
      click() {},
    };
    return node;
  };

  const ids = {};
  for (const id of ['drop', 'report', 'caveat', 'pickZip', 'pickDir', 'fileZip', 'fileDir']) {
    ids[id] = mk('div');
  }
  return {
    document: {
      getElementById: (id) => ids[id],
      createElement: mk,
    },
    ids,
  };
}

/** Depth-first text of a stub tree, one node per line, as the page renders it. */
export function renderText(node, out = []) {
  if (!node) return out;
  if (node._text) out.push(`${node.className ? `[${node.className}] ` : ''}${node._text}`);
  for (const k of node.children ?? []) renderText(k, out);
  return out;
}

/**
 * Load verify.html, hand it a zip as a dropped file, return the rendered lines.
 */
export async function verifyInPage(zipBytes, fileName = 'export.zip') {
  const html = readFileSync(fileURLToPath(new URL('verify.html', import.meta.url)), 'utf8');
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('verify.html has no module script — did the template change?');

  const { document, ids } = makeDom();
  const sandbox = {
    document,
    crypto: globalThis.crypto,
    TextDecoder,
    TextEncoder,
    DataView,
    Uint8Array,
    DecompressionStream,
    Response,
    Blob,
    fetch: () => {
      throw new Error('the ORCID button is not exercised headlessly');
    },
    console,
    RegExp,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  // Run as a plain script, not a vm module: the page imports nothing (the
  // library is inlined), so the only thing module semantics would add here is
  // a flag the caller has to remember. A collision between the library's names
  // and the page's is still a SyntaxError, which is the failure this harness
  // caught the first time it ran.
  try {
    vm.runInContext(m[1], ctx, { filename: 'verify.html' });
  } catch (e) {
    throw new Error(`verify.html failed to evaluate: ${e.message}`);
  }

  const onDrop = ids.drop.listeners.drop;
  if (!onDrop) throw new Error('verify.html registered no drop handler');
  const file = {
    name: fileName,
    arrayBuffer: async () => zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength),
  };
  await onDrop({ preventDefault() {}, dataTransfer: { files: [file] } });

  return renderText(ids.report).join('\n');
}
