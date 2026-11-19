/** Time zone → country (IANA tzdata) and the checklist offered for it. */
import { describe, expect, it } from 'vitest';
import { builtinFor, countryFromTimeZone } from '../src/geo/region';

describe('countryFromTimeZone', () => {
  it('maps current and old zone names', () => {
    expect(countryFromTimeZone('Asia/Taipei')).toBe('TW');
    expect(countryFromTimeZone('ROC')).toBe('TW');
    expect(countryFromTimeZone('Asia/Tokyo')).toBe('JP');
    expect(countryFromTimeZone('Europe/Vienna')).toBe('AT');
    // Chrome reports some zones by their old names.
    expect(countryFromTimeZone('Asia/Calcutta')).toBe('IN');
    expect(countryFromTimeZone('Europe/Kiev')).toBe('UA');
  });
  it('gives no country for zones without one', () => {
    expect(countryFromTimeZone('UTC')).toBeNull();
    expect(countryFromTimeZone('Etc/GMT+8')).toBeNull();
    expect(countryFromTimeZone(null)).toBeNull();
    expect(countryFromTimeZone('Mars/Olympus')).toBeNull();
  });
});

describe('builtinFor', () => {
  it('offers the built-in checklist for Taiwan and Japan only', () => {
    expect(builtinFor('TW')).toBe('tw-taicol');
    expect(builtinFor('JP')).toBe('jp-ylist');
    expect(builtinFor('AT')).toBeNull();
    expect(builtinFor(null)).toBeNull();
  });
});
