/**
 * Summit overview photos (manual Annex III item code SU-OV): each photo keeps
 * the viewpoint it was taken from, which Annex III makes element 8 of the file
 * name ("Description of viewpoint if SU-OV___ is used for element 5"). Pure.
 */
export type OverviewPhoto = { uri: string; viewpoint: string };

export function parseOverviewPhotos(json: string | null | undefined): OverviewPhoto[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v
      .filter((p): p is { uri: string; viewpoint?: unknown } => !!p && typeof (p as { uri?: unknown }).uri === 'string')
      .map((p) => ({ uri: p.uri, viewpoint: typeof p.viewpoint === 'string' ? p.viewpoint : '' }));
  } catch {
    return [];
  }
}

export function serializeOverviewPhotos(list: OverviewPhoto[]): string | null {
  return list.length ? JSON.stringify(list) : null;
}

/**
 * Viewpoint → Annex III element 8: words joined by '-', at most 150
 * characters. Underscores (the element separator), dots and characters no file
 * system accepts become word breaks.
 */
export function element8(text: string): string {
  return text
    .replace(/[\s_./\\:*?"<>|]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 150)
    .replace(/-$/, '');
}
