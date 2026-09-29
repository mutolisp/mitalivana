/**
 * Add a summit (03-screens-flow.md §4d, design 06b). A full-screen page, not a
 * form unfolded in the summit list: it has a keyboard, and keyboard forms are
 * full screen in this app.
 *
 * The code is validated as it is typed, so the save button is simply off
 * until it is complete — no toast after the fact. Saving goes through
 * upsertSummit unchanged; the new id is handed back to /gloria/new through
 * useSummitPick.
 */
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from '~/components/KeyboardAvoidingView';
import { SelectRow } from '~/components/settings/rows';
import { Button } from '~/components/ui/Button';
import { errText } from '~/lib/errText';
import { NUMERIC_KEYBOARD, parseNum } from '~/modules/gloria/components/ui';
import { listSummits, upsertSummit } from '~/modules/gloria/db';
import { checkRange, RANGES, type Range } from '~/modules/gloria/model/ranges';
import { VEG_ZONES } from '~/modules/gloria/model/vegZones';
import { useSummitPick } from '~/modules/gloria/store';
import { useThemeColors } from '~/theme/colors';
import { BackHeaderLeft } from '~/lib/goBack';

/** Box 6.1: country 2 letters (ISO 3166), target region and summit 3 characters. */
const PARTS = [
  { key: 'country', len: 2, allowed: /[^A-Z]/g, labelKey: 'gloria.summitNew.partCountry', errKey: 'gloria.summitNew.errCountry' },
  { key: 'region', len: 3, allowed: /[^A-Z0-9]/g, labelKey: 'gloria.summitNew.partRegion', errKey: 'gloria.summitNew.errRegion' },
  { key: 'summit', len: 3, allowed: /[^A-Z0-9]/g, labelKey: 'gloria.summitNew.partSummit', errKey: 'gloria.summitNew.errSummit' },
] as const;
type PartKey = (typeof PARTS)[number]['key'];

const FIELD =
  'rounded-xl border border-line bg-card px-3 text-base text-ink dark:border-line-dark dark:bg-card-dark dark:text-gray-100';

export default function NewSummitScreen() {
  const c = useThemeColors();
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ country?: string; region?: string }>();
  const summits = useMemo(() => listSummits(), []);

  // Country: the one last used (the most recently saved summit), else TW.
  const lastCountry = useMemo(
    () => [...summits].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0]?.country ?? 'TW',
    [summits],
  );
  const [code, setCode] = useState<Record<PartKey, string>>({
    country: (params.country ?? lastCountry).toUpperCase(),
    region: (params.region ?? '').toUpperCase(),
    summit: '',
  });
  const [focused, setFocused] = useState<PartKey | null>(null);
  const refs = { country: useRef<TextInput>(null), region: useRef<TextInput>(null), summit: useRef<TextInput>(null) };

  // Kept as typed text; parsed on save. TWD97 stays in state while hidden
  // (country not TW), so switching back does not lose it.
  const [name, setName] = useState('');
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [twdX, setTwdX] = useState('');
  const [twdY, setTwdY] = useState('');
  const [elevation, setElevation] = useState('');
  const [zone, setZone] = useState('');
  const [locating, setLocating] = useState(false);
  const [fixAccuracy, setFixAccuracy] = useState<number | null>(null);

  const complete = (k: PartKey) => code[k].length === PARTS.find((p) => p.key === k)!.len;
  const allComplete = PARTS.every((p) => complete(p.key));
  const fullCode = `${code.country}-${code.region}-${code.summit}`;
  // A part is wrong once the user has left it half-filled.
  const wrong = PARTS.find((p) => focused !== p.key && code[p.key].length > 0 && !complete(p.key));
  const existing = allComplete ? summits.find((s) => s.full_code === fullCode) : undefined;
  const isTW = code.country === 'TW';

  const setPart = (i: number, raw: string) => {
    const p = PARTS[i];
    const v = raw.toUpperCase().replace(p.allowed, '').slice(0, p.len);
    const was = code[p.key];
    setCode((prev) => ({ ...prev, [p.key]: v }));
    // Advance only when this keystroke filled the box: typing into a box that
    // was already full (a rejected extra character) must not move on.
    if (v.length === p.len && was.length < p.len && i < PARTS.length - 1) refs[PARTS[i + 1].key].current?.focus();
  };

  /** '' → ok (optional); otherwise a message for a non-number or out-of-range entry. */
  const numError = (text: string, label: string, range?: Range): string | null => {
    if (!text.trim()) return null;
    const n = parseNum(text);
    if (n == null) return t('gloria.summitNew.notNumber', { label });
    if (range && checkRange(n, range) === 'reject') {
      return t('gloria.summitNew.outOfRange', { label, min: range.min, max: range.max });
    }
    return null;
  };
  const errors = [
    numError(lat, t('gloria.summit.lat'), RANGES.latitude),
    numError(lon, t('gloria.summit.lon'), RANGES.longitude),
    isTW ? numError(twdX, 'TWD97 X') : null,
    isTW ? numError(twdY, 'TWD97 Y') : null,
    numError(elevation, t('gloria.summitNew.elevation'), RANGES.elevation),
  ];
  const canSave = allComplete && errors.every((e) => e == null);

  const locate = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(t('gnss.permTitle'), t('gnss.permMsg'));
      return;
    }
    setLocating(true);
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setLat(pos.coords.latitude.toFixed(6));
      setLon(pos.coords.longitude.toFixed(6));
      setFixAccuracy(pos.coords.accuracy ?? null);
    } catch (e) {
      Alert.alert(t('gloria.summitNew.locateFail'), errText(e));
    } finally {
      setLocating(false);
    }
  };

  const save = () => {
    if (!canSave) return;
    // Updating an existing summit: a field left blank keeps what is stored,
    // so re-adding a code cannot wipe coordinates entered elsewhere.
    const keep = <T,>(typed: T | null, stored: T | null | undefined): T | null => typed ?? stored ?? null;
    const id = upsertSummit({
      country: code.country,
      target_region: code.region,
      summit: code.summit,
      name: keep(name.trim() || null, existing?.name),
      decimal_latitude: keep(parseNum(lat), existing?.decimal_latitude),
      decimal_longitude: keep(parseNum(lon), existing?.decimal_longitude),
      twd97x: keep(parseNum(twdX), existing?.twd97x),
      twd97y: keep(parseNum(twdY), existing?.twd97y),
      elevation_m: keep(parseNum(elevation), existing?.elevation_m),
      veg_zone: keep(zone || null, existing?.veg_zone),
    });
    useSummitPick.getState().set(id);
    router.back();
  };

  const partBorder = (k: PartKey) =>
    complete(k)
      ? 'border-accent-600 dark:border-accent-400'
      : wrong?.key === k
        ? 'border-alert dark:border-alert-dark'
        : 'border-line dark:border-line-dark';

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen
        options={{
          title: t('gloria.new.addSummit'),
          headerTitleAlign: 'center',
          // The shared back (05-controls.md §3); leaving without saving is the cancel.
          headerLeft: BackHeaderLeft,
        }}
      />
      <KeyboardAvoidingView className="flex-1" behavior="padding">
        <ScrollView contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled">
          {/* Code: three boxes joined by dashes, labelled underneath. */}
          <View className="gap-2 rounded-card border border-line bg-card p-4 dark:border-line-dark dark:bg-card-dark">
            <Text className="text-xs font-bold uppercase text-gray-500 dark:text-gray-400">{t('gloria.summit.code')}</Text>
            <View className="flex-row items-start">
              {PARTS.map((p, i) => (
                <View key={p.key} className="flex-row items-start" style={{ flex: p.len }}>
                  {i > 0 ? <Text className="px-1.5 font-mono text-[22px] font-bold text-gray-500" style={{ lineHeight: 52 }}>-</Text> : null}
                  <View className="flex-1 items-center">
                    <TextInput
                      ref={refs[p.key]}
                      value={code[p.key]}
                      onChangeText={(v) => setPart(i, v)}
                      onFocus={() => setFocused(p.key)}
                      onBlur={() => setFocused((f) => (f === p.key ? null : f))}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      // Android: no suggestion strip, so the keyboard has no
                      // composing text for the upper-casing rewrite to fight
                      // (typing "das" produced "DAA"). Ignored on iOS.
                      keyboardType="visible-password"
                      maxLength={p.len}
                      placeholder={['TW', 'DAS', 'SUN'][i]}
                      placeholderTextColor={c.disabled}
                      accessibilityLabel={t(p.labelKey)}
                      returnKeyType={i < PARTS.length - 1 ? 'next' : 'done'}
                      onSubmitEditing={() => (i < PARTS.length - 1 ? refs[PARTS[i + 1].key].current?.focus() : undefined)}
                      className={`w-full rounded-xl border-[1.5px] bg-card text-center font-mono text-[22px] font-bold text-ink dark:bg-card-dark dark:text-gray-100 ${partBorder(p.key)}`}
                      style={{ height: 52 }}
                    />
                    <Text className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t(p.labelKey)}</Text>
                  </View>
                </View>
              ))}
            </View>
            <Text
              className={`text-xs ${
                wrong
                  ? 'text-alert dark:text-alert-dark'
                  : allComplete && !existing
                    ? 'font-medium text-accent-700 dark:text-accent-300'
                    : 'text-gray-500 dark:text-gray-400'
              }`}
            >
              {wrong
                ? t(wrong.errKey)
                : allComplete && !existing
                  ? t('gloria.summitNew.willCreate', { code: fullCode })
                  : t('gloria.new.codeHint')}
            </Text>
          </View>

          <View className="gap-1.5">
            <Text className="text-xs font-medium text-gray-600 dark:text-gray-400">{t('gloria.summit.name')}</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={t('gloria.new.summitName')}
              placeholderTextColor={c.ink3}
              className={FIELD}
              style={{ height: 48 }}
            />
          </View>

          {/* Position: WGS84 always; TWD97 only for Taiwanese summits. */}
          <View className="gap-2.5 rounded-card border border-line bg-card p-4 dark:border-line-dark dark:bg-card-dark">
            <View className="flex-row items-center">
              <Text className="flex-1 text-xs font-bold uppercase text-gray-500 dark:text-gray-400">{t('gloria.summitNew.position')}</Text>
              <Button
                label={locating ? t('gloria.summitNew.locating') : t('gloria.summitNew.here')}
                variant="secondary"
                icon="locate-outline"
                loading={locating}
                onPress={() => void locate()}
              />
            </View>
            {fixAccuracy != null ? (
              <Text className="text-xs text-gray-500 dark:text-gray-400">
                {t('gloria.summitNew.accuracy', { m: Math.round(fixAccuracy) })}
              </Text>
            ) : null}
            <NumRow label={t('gloria.summit.lat')} value={lat} onChange={setLat} error={errors[0]} signed />
            <NumRow label={t('gloria.summit.lon')} value={lon} onChange={setLon} error={errors[1]} signed />
            {isTW ? (
              <>
                <NumRow label="TWD97 X" value={twdX} onChange={setTwdX} error={errors[2]} unit="m" />
                <NumRow label="TWD97 Y" value={twdY} onChange={setTwdY} error={errors[3]} unit="m" />
              </>
            ) : null}
            <NumRow label={t('gloria.summitNew.elevation')} value={elevation} onChange={setElevation} error={errors[4]} unit="m" />
          </View>

          <SelectRow
            variant="inline"
            label={t('gloria.new.vegZone')}
            value={zone}
            options={[{ value: '', label: t('gloria.summit.zoneNone') }, ...VEG_ZONES]}
            onChange={setZone}
            triggerClassName="min-h-[48px]"
          />
        </ScrollView>

        <View className="gap-2 border-t border-line bg-card px-4 py-3 dark:border-line-dark dark:bg-card-dark">
          {existing ? (
            <View className="flex-row items-start">
              <Ionicons name="information-circle-outline" size={16} color={c.acornDeep} />
              <Text className="ml-1.5 flex-1 text-xs text-acorn-deep dark:text-acorn">
                {t('gloria.summitNew.exists', { code: fullCode })}
              </Text>
            </View>
          ) : null}
          <Button
            size="lg"
            fullWidth
            disabled={!canSave}
            label={
              existing
                ? t('gloria.summitNew.update')
                : allComplete
                  ? t('gloria.summitNew.saveCode', { code: fullCode })
                  : t('gloria.summitNew.save')
            }
            onPress={save}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** Label, number field with a fixed unit, and the field's own error line. */
function NumRow({
  label,
  value,
  onChange,
  error,
  unit,
  signed = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  unit?: string;
  signed?: boolean;
}) {
  const c = useThemeColors();
  return (
    <View>
      <View className="flex-row items-center">
        <Text className="flex-1 text-sm text-gray-700 dark:text-gray-300">{label}</Text>
        <View
          className={`flex-row items-center rounded-xl border bg-card px-3 dark:bg-card-dark ${
            error ? 'border-alert dark:border-alert-dark' : 'border-line dark:border-line-dark'
          }`}
          style={{ height: 44, width: 180 }}
        >
          <TextInput
            value={value}
            onChangeText={onChange}
            // The iOS decimal pad has no minus sign; coordinates need one.
            keyboardType={signed ? 'numbers-and-punctuation' : NUMERIC_KEYBOARD}
            accessibilityLabel={label}
            placeholderTextColor={c.ink3}
            className="flex-1 text-right text-base text-ink dark:text-gray-100"
            style={{ fontVariant: ['tabular-nums'] }}
          />
          {unit ? <Text className="ml-1.5 text-sm text-gray-500 dark:text-gray-400">{unit}</Text> : null}
        </View>
      </View>
      {error ? <Text className="mt-1 text-right text-xs text-alert dark:text-alert-dark">{error}</Text> : null}
    </View>
  );
}
