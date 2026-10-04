#!/usr/bin/env node
/**
 * Attaching a photo to a record that has no position must supply one.
 *
 * The bug this pins: the import flow (top-right of the 名錄 screen) read each
 * photo's EXIF and created records already positioned, while attaching a photo
 * to a record that already existed went through `pickPhotos()`, which drops
 * EXIF entirely. Same photo, same GNSS, two different outcomes — and the one
 * that lost the coordinate was the ordinary way of working: create the record,
 * then photograph the plant.
 *
 * Two halves have to stay together, which is why this is a text check (same
 * reasoning as `check-bottom-dock.mjs`): the picker that keeps EXIF, and the
 * step that writes the position when the record has none. Either half alone is
 * silently useless.
 *
 * A plot works the same way, with one extra rule. The plot records one
 * coordinate for the environment; a species inside it may additionally carry
 * its own, which is what makes a large plot usable at all. But
 * `buildContextFromPlotRecord` hands the PLOT's centre to the camera path and
 * `photoCapture` overwrites the camera's own GNSS with it, so a photo taken
 * there carries the plot centre, not the plant. Reading that back would stamp
 * the plot's coordinate onto every record as though it had been measured per
 * plant. So on the plot screen only LIBRARY photos may supply a position.
 *
 * Run: npm run check:photognss
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Screens that attach photos to a record with its own lat/lng columns. */
const GUARDED = [
  { file: '../app/session/[id].tsx', what: '名錄記錄', handler: 'const handleAddPhoto', write: 'updateRecordLocation' },
  { file: '../app/collection/[id].tsx', what: '採集標本', handler: 'const handleAddPhoto', write: 'updateSpecimenLocation' },
  {
    file: '../src/components/PlotSpeciesTab.tsx',
    what: '樣區物種',
    handler: 'const handleAddPhotoForModal',
    // Create mode inserts the coordinate with the row; edit mode updates it.
    write: 'updatePlotSpeciesLocation',
    libraryOnly: true,
  },
];

let failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('check:photognss');

for (const { file, what, handler, write, libraryOnly } of GUARDED) {
  const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

  // The handler body, so an unrelated `pickPhotos` elsewhere in the file
  // cannot satisfy or break this.
  const start = src.indexOf(handler);
  ok(start !== -1, `${what}: ${handler} found`);
  if (start === -1) continue;
  const body = src.slice(start, start + 4000);

  // Directly, or through the shared species-photo helper (2G), which is held to the same rule below.
  ok(
    body.includes('pickPhotosWithExif') || body.includes('takeSpeciesPhotos('),
    `${what}: picks with EXIF`,
    'the picker must keep asset.exif — the only legible source for a HEIC',
  );
  ok(
    !/\bpickPhotos\s*\(/.test(body),
    `${what}: does not fall back to the EXIF-dropping picker`,
  );
  ok(
    body.includes('firstPhotoFix'),
    `${what}: reads a position out of the photo`,
  );
  ok(
    body.includes(write),
    `${what}: writes it with ${write}`,
  );
  // The guard that keeps this from overwriting a measured coordinate.
  ok(
    /lat === null|lat == null/.test(body),
    `${what}: only fills in a MISSING position`,
    'a photo must never replace a measured coordinate',
  );
  if (libraryOnly) {
    // Not just "the flag is mentioned" — the read has to be GATED on it.
    // An earlier version of this check only looked for the identifier, and a
    // deliberately broken build (camera photos allowed through) passed.
    ok(
      /fromLibrary\s*\?[^;]*firstPhotoFix/.test(body),
      `${what}: the position read is gated on the photo coming from the library`,
      'a camera photo here carries the plot centre, not the plant',
    );
  }
}

// ── The shared species-photo helper (src/lib/speciesPhotos.ts, 2G) ────────
{
  const helper = readFileSync(fileURLToPath(new URL('../src/lib/speciesPhotos.ts', import.meta.url)), 'utf8');
  ok(helper.includes('pickPhotosWithExif()'), 'takeSpeciesPhotos: picks with EXIF');
  ok(!/\bpickPhotos\s*\(/.test(helper), 'takeSpeciesPhotos: does not fall back to the EXIF-dropping picker');
  ok(/rememberPickedPhotos\(picked\)/.test(helper), 'takeSpeciesPhotos: remembers the picked photos\' positions');
}

// ── Adding a plot species offers the same fields as editing one ──────────
// These were all gated on `mode === 'edit'`, so a surveyor standing at the
// plant had to save the species, reopen it, and only then could locate it or
// attach a recording — by which point they have usually walked on. The gates
// are one-word changes to re-introduce, and nothing else would notice.
{
  const tab = readFileSync(
    fileURLToPath(new URL('../src/components/PlotSpeciesTab.tsx', import.meta.url)),
    'utf8',
  );
  const props = tab.slice(tab.indexOf('<PlotSpeciesValueModal'));
  for (const prop of ['onSaveLocation', 'onChangeLocation', 'onAddAudio', 'onRemoveAudio']) {
    const line = props.split('\n').find((l) => l.trim().startsWith(`${prop}=`)) ?? '';
    ok(
      line !== '' && !line.includes("mode === 'edit'"),
      `樣區新增模式: ${prop} is offered when adding, not only when editing`,
      line.trim(),
    );
  }
  // The buffers those handlers write into, and the insert that lands them.
  for (const [needle, why] of [
    ['setPendingLoc', 'a coordinate placed before the row exists'],
    ['setPendingAudio', 'a clip recorded before the row exists'],
    ['lat: pendingLoc?.lat', 'the buffered coordinate reaches the INSERT'],
    ['updatePlotSpeciesAudio(newId', 'the buffered clips are attached after the INSERT'],
  ]) {
    ok(tab.includes(needle), `樣區新增模式: ${why}`, `missing \`${needle}\``);
  }
}

// The shared reader has to accept the picker's exif, or every HEIC silently
// reports "no GNSS" and the two halves above achieve nothing.
{
  const meta = readFileSync(
    fileURLToPath(new URL('../src/lib/photoMeta.ts', import.meta.url)),
    'utf8',
  );
  ok(
    meta.includes('PhotoFixSource'),
    'firstPhotoFix accepts picker EXIF alongside the uri',
  );
  ok(
    /readPhotoMeta\(uri, exif\)/.test(meta),
    'firstPhotoFix passes that exif through to readPhotoMeta',
  );
}

if (failed > 0) {
  console.error(`✗ photo-gnss: ${failed} failure(s)`);
  process.exit(1);
}
console.log('✓ photo-gnss: attaching a photo fills in a missing position, never replaces one');
