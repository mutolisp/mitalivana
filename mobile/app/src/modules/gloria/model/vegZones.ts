/** Vegetation zones as the project records them (sheet 00_ "Vegetation Zone"). Pure. */
export const VEG_ZONES = [
  { value: 'treeline ecotone', label: 'treeline ecotone' },
  { value: 'lower alpine', label: 'lower alpine' },
  { value: 'alpine', label: 'alpine (lower/upper alpine ecotone)' },
  { value: 'upper alpine', label: 'upper alpine' },
  { value: 'subnival', label: 'subnival (alpine to nival ecotone)' },
  { value: 'nival', label: 'nival' },
] as const;

/** A typed zone → its stored value (case and spacing ignored; the long label counts too). */
export function normalizeVegZone(raw: string): string | null {
  const k = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!k) return null;
  const hit = VEG_ZONES.find((z) => z.value === k || z.label.toLowerCase() === k);
  return hit ? hit.value : null;
}
