/**
 * New / edit permanent plot (docs/ForestGEO/Stem_mapping.md, "樣區"). Size,
 * quadrat and subquadrat sides, tag blocks and the DBH threshold are fixed once
 * a census exists (stemmapCore enforces it; here they are shown read-only).
 * The form is kept as text and saved as a whole.
 */
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NumAccessory } from '~/components/form/NumField';
import { Seg } from '~/components/form/Segmented';
import { Button } from '~/components/ui/Button';
import { BackHeaderLeft } from '~/lib/goBack';
import { captureFix } from '~/lib/gnssFix';
import { parseNum } from '~/lib/parseNum';
import { useToast } from '~/stores/toast';
import { DraftNum } from '~/survey/components/DraftNum';
import { Field, FormCard, Hint, Problem, TextBox } from '~/survey/components/FormBits';
import { createFrame, frameHasSurveys, getFrame, SurveyError, updateFrame, type FramePatch } from '~/survey/db/stemmap';
import { validateGeometry, type GeometryProblem } from '~/survey/stemmap/coords';

const str = (v: number | null | undefined) => (v == null ? '' : String(v));

export default function SurveyFrameEditScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const { id: idParam } = useLocalSearchParams<{ id?: string }>();
  const id = idParam ? Number(idParam) : null;
  const frame = useMemo(() => (id == null ? null : getFrame(id)), [id]);
  const locked = useMemo(() => (id == null ? false : frameHasSurveys(id)), [id]);

  const [code, setCode] = useState(frame?.code ?? '');
  const [name, setName] = useState(frame?.name ?? '');
  const [sizeX, setSizeX] = useState(str(frame?.size_x_m));
  const [sizeY, setSizeY] = useState(str(frame?.size_y_m));
  const [quadratM, setQuadratM] = useState(str(frame?.quadrat_m ?? 20));
  const [subM, setSubM] = useState(str(frame?.subquadrat_m ?? 5));
  const [blockQ, setBlockQ] = useState(str(frame?.tag_block_quadrats ?? 5));
  const [blockSize, setBlockSize] = useState(str(frame?.tag_block_size ?? 10000));
  const [dbhMin, setDbhMin] = useState<'1' | '5'>(frame?.dbh_min_cm === 5 ? '5' : '1');
  const [lat, setLat] = useState(str(frame?.origin_lat));
  const [lng, setLng] = useState(str(frame?.origin_lng));
  const [acc, setAcc] = useState(str(frame?.origin_accuracy_m));
  const [bearing, setBearing] = useState(str(frame?.bearing_deg ?? 0));
  const [bearingRef, setBearingRef] = useState<'true' | 'magnetic'>(frame?.bearing_ref ?? 'true');
  const [decl, setDecl] = useState(str(frame?.declination_deg ?? 0));
  const [extremePct, setExtremePct] = useState(str(Math.round((frame?.extreme_pct ?? 0.05) * 1000) / 10));
  const [extremeMin, setExtremeMin] = useState(str(frame?.extreme_min ?? 3));
  const [notes, setNotes] = useState(frame?.notes ?? '');
  const [busy, setBusy] = useState(false);
  // Required fields are marked only once a save was tried.
  const [tried, setTried] = useState(false);

  const n = (s: string) => parseNum(s);
  const geomProblems: GeometryProblem[] = useMemo(() => {
    const g = { sizeXM: n(sizeX) ?? 0, sizeYM: n(sizeY) ?? 0, quadratM: n(quadratM) ?? 0, subquadratM: n(subM) ?? 0 };
    if (!sizeX || !sizeY) return [];
    return validateGeometry({ ...g, originLat: null, originLng: null, bearingDeg: 0, bearingRef: 'true', declinationDeg: 0 });
  }, [sizeX, sizeY, quadratM, subM]);
  const problemText = (p: GeometryProblem) => {
    switch (p) {
      case 'not_positive':
        return t('survey.frame.errNotPositive');
      case 'size_not_multiple':
        return t('survey.frame.errSizeMultiple');
      case 'quadrat_not_multiple':
        return t('survey.frame.errQuadratMultiple');
      case 'too_many_quadrats':
        return t('survey.frame.errTooMany');
    }
  };

  const takeFix = async () => {
    setBusy(true);
    try {
      const fix = await captureFix();
      if (!fix) return;
      setLat(String(fix.lat));
      setLng(String(fix.lng));
      setAcc(fix.accuracy == null ? '' : String(Math.round(fix.accuracy * 10) / 10));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const sx = n(sizeX);
    const sy = n(sizeY);
    const latN = n(lat);
    const lngN = n(lng);
    const bearingN = n(bearing) ?? 0;
    const declN = n(decl) ?? 0;
    const pct = n(extremePct);
    const minN = n(extremeMin);
    setTried(true);
    const fail = (msg: string) => {
      toast(msg);
      return;
    };
    // parseNum reads non-numbers as empty, which would turn into defaults here.
    const numeric: [string, string][] = [
      [t('survey.frame.sizeX'), sizeX],
      [t('survey.frame.sizeY'), sizeY],
      [t('survey.frame.quadratM'), quadratM],
      [t('survey.frame.subquadratM'), subM],
      [t('survey.frame.tagBlockQuadrats'), blockQ],
      [t('survey.frame.tagBlockSize'), blockSize],
      [t('survey.frame.lat'), lat],
      [t('survey.frame.lng'), lng],
      [t('survey.frame.accuracy'), acc],
      [t('survey.frame.bearing'), bearing],
      [t('survey.frame.declination'), decl],
      [t('survey.frame.extremePct'), extremePct],
      [t('survey.frame.extremeMin'), extremeMin],
    ];
    const unreadable = numeric.filter(([, v]) => v.trim() !== '' && n(v) == null).map(([label]) => label);
    if (unreadable.length) {
      Alert.alert(t('survey.tree.cannotSave'), `${t('survey.tree.errNumber')}\n${unreadable.map((x) => `• ${x}`).join('\n')}`);
      return;
    }
    if (!code.trim()) return fail(t('survey.frame.errCode'));
    if (sx == null || sy == null || geomProblems.length) return fail(t('survey.frame.errGeometry'));
    if ((latN == null) !== (lngN == null) || (latN != null && (latN < -90 || latN > 90)) || (lngN != null && (lngN < -180 || lngN > 180)))
      return fail(t('survey.frame.errOrigin'));
    if (bearingN < 0 || bearingN >= 360) return fail(t('survey.frame.errBearing'));
    if (declN < -90 || declN > 90) return fail(t('survey.frame.errDeclination'));
    if (pct == null || pct <= 0 || pct > 50 || minN == null || !Number.isInteger(minN) || minN < 1) return fail(t('survey.frame.errExtreme'));
    const blockQN = n(blockQ);
    const blockSizeN = n(blockSize);
    if (blockQN == null || !Number.isInteger(blockQN) || blockQN < 1 || blockSizeN == null || !Number.isInteger(blockSizeN) || blockSizeN < 1)
      return fail(t('survey.frame.errTagBlock'));
    const common: FramePatch = {
      name: name.trim() || null,
      originLat: latN,
      originLng: lngN,
      originAccuracyM: n(acc),
      bearingDeg: bearingN,
      bearingRef,
      declinationDeg: declN,
      notes: notes.trim() || null,
    };
    const grid: FramePatch = {
      sizeXM: sx,
      sizeYM: sy,
      quadratM: n(quadratM) ?? 20,
      subquadratM: n(subM) ?? 5,
      tagBlockQuadrats: blockQN,
      tagBlockSize: blockSizeN,
      dbhMinCm: dbhMin === '5' ? 5 : 1,
    };
    try {
      if (id == null) {
        const newId = createFrame({ code: code.trim(), ...common, ...grid, sizeXM: sx, sizeYM: sy, extremePct: pct / 100, extremeMin: minN });
        router.replace(`/survey/frame/${newId}` as Href);
      } else {
        updateFrame(id, { code: code.trim(), ...common, ...(locked ? {} : grid), extremePct: pct / 100, extremeMin: minN });
        router.back();
      }
    } catch (e) {
      if (e instanceof SurveyError && e.code === 'frame_code_taken') return fail(t('survey.frame.errCodeTaken'));
      if (e instanceof SurveyError && e.code === 'frame_locked') return fail(t('survey.frame.locked'));
      if (e instanceof SurveyError && e.code === 'geometry_invalid') return fail(t('survey.frame.errGeometry'));
      throw e;
    }
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen options={{ title: id == null ? t('survey.frame.new') : t('survey.frame.edit'), headerLeft: BackHeaderLeft }} />
      <KeyboardAwareScrollView className="flex-1" contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled" bottomOffset={24}>
        <FormCard>
          <Field label={t('survey.frame.code')}>
            <TextBox value={code} onChange={setCode} accessibilityLabel={t('survey.frame.code')} autoCapitalize="characters" invalid={tried && !code.trim()} />
          </Field>
          <Field label={t('survey.frame.name')}>
            <TextBox value={name} onChange={setName} accessibilityLabel={t('survey.frame.name')} />
          </Field>
        </FormCard>

        <FormCard title={t('survey.frame.grid')}>
          {locked ? <Hint>{t('survey.frame.locked')}</Hint> : null}
          <View className="flex-row gap-3">
            <Field label={t('survey.frame.sizeX')} className="flex-1">
              <DraftNum value={sizeX} onChange={setSizeX} accessibilityLabel={t('survey.frame.sizeX')} width="100%" editable={!locked} invalid={tried && !sizeX} />
            </Field>
            <Field label={t('survey.frame.sizeY')} className="flex-1">
              <DraftNum value={sizeY} onChange={setSizeY} accessibilityLabel={t('survey.frame.sizeY')} width="100%" editable={!locked} invalid={tried && !sizeY} />
            </Field>
          </View>
          <View className="flex-row gap-3">
            <Field label={t('survey.frame.quadratM')} className="flex-1">
              <DraftNum value={quadratM} onChange={setQuadratM} accessibilityLabel={t('survey.frame.quadratM')} width="100%" editable={!locked} />
            </Field>
            <Field label={t('survey.frame.subquadratM')} className="flex-1">
              <DraftNum value={subM} onChange={setSubM} accessibilityLabel={t('survey.frame.subquadratM')} width="100%" editable={!locked} />
            </Field>
          </View>
          {geomProblems.map((p) => (
            <Problem key={p}>{problemText(p)}</Problem>
          ))}
          <Field label={t('survey.frame.dbhMin')}>
            <View pointerEvents={locked ? 'none' : 'auto'} className={locked ? 'opacity-60' : ''}>
              <Seg
                value={dbhMin}
                options={[
                  { value: '1', label: t('survey.frame.dbhMinOption', { cm: 1 }) },
                  { value: '5', label: t('survey.frame.dbhMinOption', { cm: 5 }) },
                ]}
                onChange={setDbhMin}
              />
            </View>
          </Field>
          <View className="flex-row gap-3">
            <Field label={t('survey.frame.tagBlockQuadrats')} className="flex-1">
              <DraftNum value={blockQ} onChange={setBlockQ} accessibilityLabel={t('survey.frame.tagBlockQuadrats')} width="100%" editable={!locked} />
            </Field>
            <Field label={t('survey.frame.tagBlockSize')} className="flex-1">
              <DraftNum value={blockSize} onChange={setBlockSize} accessibilityLabel={t('survey.frame.tagBlockSize')} width="100%" editable={!locked} />
            </Field>
          </View>
          <Hint>{t('survey.frame.tagBlockHint')}</Hint>
        </FormCard>

        <FormCard title={t('survey.frame.origin')}>
          <Hint>{t('survey.frame.originHint')}</Hint>
          <View className="flex-row gap-3">
            <Field label={t('survey.frame.lat')} className="flex-1">
              <DraftNum value={lat} onChange={setLat} accessibilityLabel={t('survey.frame.lat')} width="100%" signed />
            </Field>
            <Field label={t('survey.frame.lng')} className="flex-1">
              <DraftNum value={lng} onChange={setLng} accessibilityLabel={t('survey.frame.lng')} width="100%" signed />
            </Field>
          </View>
          <View className="flex-row items-end gap-3">
            <Field label={t('survey.frame.accuracy')} className="flex-1">
              <DraftNum value={acc} onChange={setAcc} accessibilityLabel={t('survey.frame.accuracy')} width="100%" />
            </Field>
            <Button label={t('survey.frame.takeFix')} icon="locate-outline" variant="secondary" onPress={() => void takeFix()} loading={busy} className="flex-1" />
          </View>
          <View className="flex-row gap-3">
            <Field label={t('survey.frame.bearing')} className="flex-1">
              <DraftNum value={bearing} onChange={setBearing} accessibilityLabel={t('survey.frame.bearing')} width="100%" />
            </Field>
            <Field label={t('survey.frame.declination')} className="flex-1">
              <DraftNum value={decl} onChange={setDecl} accessibilityLabel={t('survey.frame.declination')} width="100%" signed />
            </Field>
          </View>
          <Seg
            value={bearingRef}
            options={[
              { value: 'true', label: t('survey.frame.trueNorth') },
              { value: 'magnetic', label: t('survey.frame.magneticNorth') },
            ]}
            onChange={setBearingRef}
          />
          <Hint>{t('survey.frame.bearingHint')}</Hint>
        </FormCard>

        <FormCard title={t('survey.frame.extreme')}>
          <View className="flex-row gap-3">
            <Field label={t('survey.frame.extremePct')} className="flex-1">
              <DraftNum value={extremePct} onChange={setExtremePct} accessibilityLabel={t('survey.frame.extremePct')} width="100%" />
            </Field>
            <Field label={t('survey.frame.extremeMin')} className="flex-1">
              <DraftNum value={extremeMin} onChange={setExtremeMin} accessibilityLabel={t('survey.frame.extremeMin')} width="100%" />
            </Field>
          </View>
          <Hint>{t('survey.frame.extremeHint')}</Hint>
        </FormCard>

        <FormCard>
          <Field label={t('survey.frame.notes')}>
            <TextBox value={notes} onChange={setNotes} accessibilityLabel={t('survey.frame.notes')} multiline />
          </Field>
        </FormCard>

        <Button label={t('common.save')} size="lg" onPress={save} fullWidth className="mb-4" />
      </KeyboardAwareScrollView>
      <NumAccessory />
    </SafeAreaView>
  );
}
