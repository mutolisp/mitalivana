/**
 * Turn a reverse-geocoded address into the locality line of a specimen.
 *
 * Pure (no Expo import) so `check:label` runs it under Node; the network call
 * lives in `reverseGeocode.ts`.
 *
 * Taiwan: `縣市：鄉鎮市區(County: District), Taiwan`, the district in Tongyong
 * pinyin (never Hanyu). Elsewhere, the geocoder's own wording, as below.
 *
 * The address comes back in the DEVICE's language, from Apple on iOS and
 * Google on Android, so both word orders occur:
 *   - CJK: largest unit first, no separators — 臺北市大安區辛亥路
 *   - Latin script: smallest unit first, comma-separated — Xinhai Rd, Da'an
 *     District, Taipei City, Taiwan
 * The street number is left out on purpose: a collecting site is a place, not
 * a postal address, and a house number next to a mountain trail is noise.
 */
import { TW_COUNTY_EN, TW_DISTRICTS } from './twAdminNames';

export type AddressParts = {
  country?: string | null;
  isoCountryCode?: string | null;
  region?: string | null;
  subregion?: string | null;
  city?: string | null;
  district?: string | null;
  street?: string | null;
};

const CJK = /[\u3040-\u30ff\u3400-\u9fff]/;

/** Taiwan's official place names use 臺 (臺北、臺中、臺南、臺東、臺灣). */
const toOfficialTai = (s: string) => s.replace(/台(?=[北中南東灣])/g, '臺');

/** Letters only, lower case, type words dropped: "Da'an Dist." → "daan". */
const latinKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b(district|dist|township|city|county|islands)\b/g, '')
    .replace(/[^a-z]/g, '');

/**
 * A Taiwan address as 縣市：鄉鎮市區 with its English in parentheses —
 * Tongyong pinyin for the township/district (see `twAdminNames.ts`) — e.g.
 * `臺北市：大安區(Taipei City: Da-an District), Taiwan`.
 *
 * The geocoder may answer in Chinese or English and spreads the two units
 * over different fields depending on the platform, so every field is tried:
 * first for the county, then for a district of THAT county (大安區 exists in
 * both 臺北市 and 臺中市).
 */
function taiwanPlace(a: AddressParts): string | null {
  const fields = [a.region, a.subregion, a.city, a.district]
    .map((p) => toOfficialTai((p ?? '').trim()))
    .filter(Boolean);
  const counties = Object.keys(TW_COUNTY_EN);
  const letters = (x: string) => x.toLowerCase().replace(/[^a-z]/g, '');
  // Chinese, or the full English name. "Hsinchu" alone could be 新竹市 or
  // 新竹縣, so the name without City/County is accepted only when it names
  // exactly one of them.
  let county = counties.find((c) =>
    fields.some((f) => f === c || letters(f) === letters(TW_COUNTY_EN[c])),
  );
  if (!county) {
    const loose = counties.filter((c) =>
      fields.some((f) => latinKey(f) !== '' && latinKey(f) === latinKey(TW_COUNTY_EN[c])),
    );
    if (loose.length === 1) county = loose[0];
  }
  if (!county) return null;
  const countyEn = TW_COUNTY_EN[county];
  const district = TW_DISTRICTS.find(
    (d) =>
      d.county === county &&
      fields.some((f) => f === d.district || latinKey(f) === latinKey(d.hanyu)),
  );
  if (!district) return `${county}(${countyEn}), Taiwan`;
  return `${county}：${district.district}(${countyEn}: ${district.tongyong}), Taiwan`;
}

const isTaiwan = (a: AddressParts) =>
  a.isoCountryCode === 'TW' || /^(台灣|臺灣|Taiwan)$/i.test((a.country ?? '').trim());

export function formatPlace(a: AddressParts): string | null {
  // Taiwan gets the county：district form with its English; everywhere else
  // keeps the geocoder's own wording, in the device language.
  if (isTaiwan(a)) {
    const tw = taiwanPlace(a);
    if (tw) return tw;
  }
  const raw = [a.region, a.subregion, a.city, a.district, a.street]
    .map((p) => (p ?? '').trim())
    .filter(Boolean);
  // Providers repeat a unit across fields (city === region for 臺北市);
  // keep the first occurrence only.
  const units = raw.filter((p, i) => raw.indexOf(p) === i);
  if (units.length === 0) return null;
  const cjk = units.some((u) => CJK.test(u));
  const country = (a.country ?? '').trim();
  const home = isTaiwan(a);
  if (cjk) {
    // The country is only worth printing when it is not Taiwan.
    const out = (country && !home ? country : '') + units.join('');
    return toOfficialTai(out);
  }
  return [...units].reverse().concat(country ? [country] : []).join(', ');
}
