/**
 * Where the user probably is, from the device's time zone only: no location
 * permission, no network, nothing leaves the device. Phones switch time zone
 * on arrival, so a traveller is placed where they are. A zone shared by
 * several countries is assigned to one of them (IANA zone.tab), and "UTC" and
 * similar give no country, which is why the choice can always be changed.
 */
import type { WebDatasetId } from '../host/datasetsHost';
import { TZ_COUNTRY } from './tzCountry.generated';

export function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** ISO 3166 country code for a time zone, or null. */
export function countryFromTimeZone(tz: string | null = deviceTimeZone()): string | null {
  return (tz && TZ_COUNTRY[tz]) || null;
}

/** The built-in checklist for a country, or null (a GBIF country pack instead). */
export function builtinFor(country: string | null): WebDatasetId | null {
  return country === 'TW' ? 'tw-taicol' : country === 'JP' ? 'jp-ylist' : null;
}
