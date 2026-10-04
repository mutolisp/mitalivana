/**
 * 調查資料 in four groups (2G-f; canvas 16f–16l, decided 2026-10-04): the list
 * (the checklist style's 調查資料 page, the plot style's environment tab) and
 * one group's page body, both styles alike (surveyGroups.ts sorts them).
 *
 * Each group draws the blocks the fixed plot's environment tab has:
 *   - 基本資料: the template's environment as its 地形、地表覆蓋 section (with
 *     開闊度), choices, photos and the rest in their editors, a comment as a
 *     row opening the full-screen notes editor, then the surveyors;
 *   - 時間資料: the survey time (date and time apart, 設為現在);
 *   - 空間資料: the centre card (GNSS, the map to place it, the boundary), the
 *     地理樣區 and the track;
 *   - 調查法: the Method editor (with the quadrats' size when the template
 *     has quadrats).
 */
import { Ionicons } from '@expo/vector-icons';
import { useRouter, type Href } from 'expo-router';
import { useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, Text, View } from 'react-native';
import { Section } from '~/components/form/Section';
import { NotesEditModal } from '~/components/NotesEditModal';
import { CentreLocationCard, EnvAdvancedSection, EnvPhotoSectionView, SurveyorRow, SurveyTimeBox, type EnvField, type EnvValues } from '~/components/plot/EnvSections';
import { SiteAssignSheet } from '~/components/SiteAssignSheet';
import { SurveyorAssignSheet } from '~/components/SurveyorAssignSheet';
import { TrackControlView } from '~/components/TransectTrackControl';
import { getSite, parseGeometry, parseTrackSegments, type GeoJSONGeometry } from '~/db';
import { withTransaction } from '~/db/init';
import { isoStamp } from '~/lib/datetime';
import { errText } from '~/lib/errText';
import { captureFix } from '~/lib/gnssFix';
import { trackLengthMeters } from '~/lib/track';
import { pauseRecording, startRecording, useTrackRecorder } from '~/lib/trackRecorder';
import type { RecordEditing } from '~/lib/useRecordEditing';
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';
import { instanceProblems, requiredByAuthor } from '~/survey/componentRules';
import { choiceList, codeLabel } from '~/survey/components/editors/ChoiceEditor';
import { ComponentEditor, componentLabel, componentSummary } from '~/survey/components/editors/ComponentEditor';
import { isRequiredMissing, RequiredMissingLine } from '~/survey/components/editors/shared';
import type { ComponentOwner } from '~/survey/db/surveyCore';
import { addMedia, removeMedia, updateSurvey, writeComponent } from '~/survey/db/surveys';
import type { FieldValue } from '~/survey/registry';
import type { ComponentInstance } from '~/survey/template/types';
import { groupStatus, surveyGroups, type GroupKey, type GroupStatus } from './surveyGroups';
import { carriedNotes, formErrorText } from './text';
import type { SurveyForm } from './useSurveyForm';

/** i18n keys (literal, so check:i18n sees them). */
export const GROUP_TITLE: Readonly<Record<GroupKey, string>> = {
  basic: 'surveyForm.group.basic',
  time: 'surveyForm.group.time',
  space: 'surveyForm.group.space',
  method: 'surveyForm.group.method',
};
const GROUP_ICON: Readonly<Record<GroupKey, keyof typeof Ionicons.glyphMap>> = {
  basic: 'list-outline',
  time: 'time-outline',
  space: 'location-outline',
  method: 'grid-outline',
};

const stamp = (ts: number | null) => (ts == null ? '' : isoStamp(ts).slice(0, 16));

/** A group's icon disc, in the list row and at the head of its single-page section. */
function GroupDisc({ group }: { group: GroupKey }) {
  const c = useThemeColors();
  return (
    <View className="h-10 w-10 items-center justify-center rounded-full bg-disc dark:bg-disc-dark">
      <Ionicons name={GROUP_ICON[group]} size={20} color={c.ink2} />
    </View>
  );
}

/** A group's name, how much of it is filled and its 必填未填 count. */
function GroupTitleRow({ group, st }: { group: GroupKey; st: GroupStatus }) {
  const { t } = useTranslation();
  return (
    <View className="flex-row flex-wrap items-baseline gap-2">
      <Text className="text-base font-bold text-ink dark:text-gray-100">{t(GROUP_TITLE[group])}</Text>
      <Text className="text-xs text-ink-3 dark:text-gray-400">{`${st.filled}/${st.total}`}</Text>
      {st.missing ? <Text className="text-xs font-semibold text-alert dark:text-alert-dark">{t('surveyForm.group.missing', { count: st.missing })}</Text> : null}
    </View>
  );
}

const groupA11y = (t: TFunction, group: GroupKey, st: GroupStatus) =>
  [t(GROUP_TITLE[group]), t('surveyForm.dataFilled', { filled: st.filled, total: st.total }), st.missing ? t('surveyForm.group.missing', { count: st.missing }) : ''].filter(Boolean).join(', ');

/** The list: a row per group with how much of it is filled and what it holds. */
export function SurveyGroupList({ data, onOpen }: { data: SurveyForm; onOpen: (g: GroupKey) => void }) {
  const c = useThemeColors();
  const { t, i18n } = useTranslation();
  const { survey, template } = data;
  const groups = surveyGroups(template);
  const summary = (key: GroupKey, comps: readonly ComponentInstance[]): string => {
    switch (key) {
      case 'basic':
        return [
          ...comps.map((x) => {
            const s = componentSummary(t, i18n.language, x, data.surveyValues[x.key] ?? {}, template.codelists);
            return s ? `${componentLabel(t, i18n.language, x)} ${s}` : '';
          }),
          survey.investigators ?? '',
        ]
          .filter(Boolean)
          .join(' · ');
      case 'time':
        return [`${t('surveyTime.start')} ${stamp(survey.start_ts)}`, survey.stop_ts != null ? `${t('surveyTime.end')} ${stamp(survey.stop_ts)}` : t('records.inProgress')].join(' · ');
      case 'space': {
        const site = survey.site_id != null ? getSite(survey.site_id) : null;
        const segments = parseTrackSegments(survey.track_geojson);
        const km = segments.length ? Math.round(trackLengthMeters(segments) / 100) / 10 : null;
        return [
          survey.lat != null && survey.lng != null ? `${survey.lat.toFixed(5)}, ${survey.lng.toFixed(5)}${survey.accuracy != null ? ` ±${Math.round(survey.accuracy)} m` : ''}` : '',
          site?.name ?? '',
          km != null ? `${t('surveyForm.track')} ${km} km` : '',
        ]
          .filter(Boolean)
          .join(' · ');
      }
      case 'method':
        return comps.map((x) => componentSummary(t, i18n.language, x, data.surveyValues[x.key] ?? {}, template.codelists)).join(' · ');
    }
  };
  return (
    <View className="mx-4 my-3 overflow-hidden rounded-card border border-line bg-card dark:border-line-dark dark:bg-card-dark">
      {groups.map((g, i) => {
        const st = groupStatus(g, data.surveyValues, survey);
        const line = summary(g.key, g.components);
        return (
          <Pressable
            key={g.key}
            onPress={() => onOpen(g.key)}
            accessibilityRole="button"
            accessibilityLabel={groupA11y(t, g.key, st)}
            className={`min-h-[76px] flex-row items-center gap-3 px-4 py-3 active:opacity-70 ${i ? 'border-t border-line dark:border-line-dark' : ''}`}
          >
            <GroupDisc group={g.key} />
            <View className="flex-1 gap-0.5">
              <GroupTitleRow group={g.key} st={st} />
              {line ? (
                <Text className="text-xs leading-4 text-ink-2 dark:text-gray-300" numberOfLines={2}>
                  {line}
                </Text>
              ) : null}
            </View>
            <Ionicons name="chevron-forward" size={18} color={c.ink3} />
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * 調查資料 on one page (`survey_data_layout` 'single', asked 2026-10-04): every
 * group in turn, under a heading with its fill count, each with the same body
 * as its own page. `onChanged` as for SurveyGroupBody.
 */
export function SurveyGroupSections({ data, edit, onChanged }: { data: SurveyForm; edit: RecordEditing; onChanged: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      {surveyGroups(data.template).map((g, i) => {
        const st = groupStatus(g, data.surveyValues, data.survey);
        return (
          <View key={g.key}>
            <View
              accessibilityRole="header"
              accessibilityLabel={groupA11y(t, g.key, st)}
              className={`flex-row items-center gap-3 px-4 pb-1 pt-4 ${i ? 'mt-3 border-t border-line dark:border-line-dark' : ''}`}
            >
              <GroupDisc group={g.key} />
              <View className="flex-1">
                <GroupTitleRow group={g.key} st={st} />
              </View>
            </View>
            <SurveyGroupBody data={data} edit={edit} group={g.key} onChanged={onChanged} />
          </View>
        );
      })}
    </>
  );
}

/** One group's page body. `onChanged`: read the survey again (and take the undo step). */
export function SurveyGroupBody({ data, edit, group, onChanged }: { data: SurveyForm; edit: RecordEditing; group: GroupKey; onChanged: () => void }) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const { survey, template } = data;
  const id = survey.id;
  const owner: ComponentOwner = { kind: 'survey', id };
  const [surveyorOpen, setSurveyorOpen] = useState(false);
  const [siteOpen, setSiteOpen] = useState(false);
  const [notesKey, setNotesKey] = useState<string | null>(null);
  const recordingTarget = useTrackRecorder((s) => s.recordingTarget);
  const livePoints = useTrackRecorder((s) => s.livePoints);
  const recording = recordingTarget?.kind === 'modular' && recordingTarget.id === id;
  const segments = useMemo(() => parseTrackSegments(survey.track_geojson), [survey.track_geojson]);
  const site = useMemo(() => (survey.site_id !== null ? getSite(survey.site_id) : null), [survey.site_id]);
  const boundary = useMemo((): GeoJSONGeometry | null => {
    if (!site) return null;
    try {
      return parseGeometry(site);
    } catch {
      return null;
    }
  }, [site]);
  const comps = surveyGroups(template).find((g) => g.key === group)?.components ?? [];
  const carried = carriedNotes(t, data.carried);
  const label = (c: ComponentInstance) => componentLabel(t, i18n.language, c);
  const ownLabel = (c: ComponentInstance) => (c.label ? label(c) : undefined);

  /** One edit: refused while locked; a value the store refuses is told. */
  const write = (run: () => void) => {
    if (edit.refuse()) return;
    try {
      run();
    } catch (e) {
      toast(formErrorText(t, e));
    }
    onChanged();
  };

  const captureGps = async () => {
    if (edit.refuse()) return;
    const fix = await captureFix();
    if (!fix) return;
    write(() =>
      updateSurvey(id, {
        lat: fix.lat,
        lng: fix.lng,
        accuracy: fix.accuracy,
        // The fix's altitude, as on the fixed plot; a typed elevation stays.
        ...(fix.altitudeM != null && survey.elevation_source !== 'manual' ? { elevationM: Math.round(fix.altitudeM), elevationSource: 'gnss' as const } : {}),
      }),
    );
  };

  const startTrack = async () => {
    if (edit.refuse()) return;
    if (recordingTarget && !recording) {
      Alert.alert(t('transect.busyTitle'), t('transect.busyMsg'));
      return;
    }
    try {
      await startRecording({ kind: 'modular', id });
      onChanged();
    } catch (e) {
      Alert.alert(t('transect.startFail'), errText(e));
    }
  };

  const section = (c: ComponentInstance) => {
    const v = data.surveyValues[c.key] ?? {};
    const note = carried[c.key] ? <Text className="mb-2 text-xs leading-4 text-ink-2 dark:text-gray-300">{carried[c.key]}</Text> : null;
    // 必填 by the template's author: a mark on its title, and a line while nothing is in it (2G-e).
    const required = requiredByAuthor(c);
    const missing = instanceProblems(c, v).some((p) => p.code === 'required_missing');
    const marked = (title: string) => (required ? `${title} *` : title);
    const alert = missing ? t('survey.editor.problem.requiredMissing') : undefined;
    switch (c.type) {
      case 'environment': {
        const fields = Array.isArray(c.params.fields) ? (c.params.fields as string[]) : [];
        const grades = typeof c.params.openness_list === 'string' ? choiceList(template.codelists, c.params.openness_list) : undefined;
        return (
          <View key={c.key}>
            {note ? <View className="px-4 pt-3">{note}</View> : null}
            <EnvAdvancedSection
              title={marked(ownLabel(c) ?? t('plot.advanced'))}
              alert={alert}
              defaultExpanded
              fields={fields.filter((f) => f !== 'openness') as EnvField[]}
              openness={
                fields.includes('openness')
                  ? { grades: grades ? grades.items.filter((it) => !it.deprecated || it.code === v.openness_grade).map((it) => ({ code: it.code, label: codeLabel(t, i18n.language, it, it.code) })) : null }
                  : undefined
              }
              values={v as EnvValues}
              // A typed elevation is a manual one, as on the fixed plot.
              onPatch={(p) => write(() => writeComponent(owner, c.key, 'elevation_m' in p ? { ...p, elevation_source: p.elevation_m != null ? 'manual' : null } : p))}
            />
          </View>
        );
      }
      case 'photos':
        return (
          <View key={c.key}>
            <EnvPhotoSectionView
              title={required ? marked(ownLabel(c) ?? t('plot.envPhotos')) : ownLabel(c)}
              alert={alert}
            photos={Array.isArray(v.photos) ? (v.photos as string[]) : []}
              onAppend={(uris) => write(() => withTransaction(() => uris.forEach((uri) => addMedia(owner, c.key, uri))))}
              onRemove={(uri) => write(() => removeMedia(owner, c.key, uri))}
            />
          </View>
        );
      case 'comments': {
        const text = typeof v.notes === 'string' ? v.notes : '';
        return (
          <Section key={c.key} title={label(c)} required={required}>
            <Pressable
              onPress={() => (edit.refuse() ? undefined : setNotesKey(c.key))}
              accessibilityRole="button"
              className="rounded-lg border border-gray-200 bg-card px-3 py-3 active:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:active:bg-gray-800"
            >
              <Text className={`text-sm ${text ? 'text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'}`}>{text || t('species.addNote')}</Text>
            </Pressable>
          </Section>
        );
      }
      default: {
        return (
          <Section key={c.key} title={label(c)} required={required}>
            {note}
            {alert ? <View className="mb-2"><RequiredMissingLine problems={instanceProblems(c, v)} /></View> : null}
            <ComponentEditor
              instance={c}
              values={v}
              problems={instanceProblems(c, v).filter((p) => !isRequiredMissing(p))}
              readOnly={edit.locked}
              onChange={(patch: Record<string, FieldValue>) => write(() => writeComponent(owner, c.key, patch))}
              context={{
                codelists: template.codelists,
                noAutoFocus: true,
                quadrats: template.style === 'plot' && (template.units?.length ?? 0) >= 2,
                onAddMedia: (uri) => write(() => void addMedia(owner, c.key, uri)),
                onRemoveMedia: (uri) => write(() => removeMedia(owner, c.key, uri)),
              }}
            />
          </Section>
        );
      }
    }
  };
  const notesComp = notesKey ? (comps.find((c) => c.key === notesKey) ?? null) : null;

  return (
    <View pointerEvents={edit.locked ? 'none' : 'auto'}>
      {group === 'basic' ? (
        <>
          {/* Template order, then the surveyors, a comment last (canvas 16g). */}
          {comps.filter((c) => c.type !== 'comments').map(section)}
          <Section title={t('surveyForm.group.people')}>
            <SurveyorRow value={survey.investigators} onPress={() => (edit.refuse() ? undefined : setSurveyorOpen(true))} />
          </Section>
          {comps.filter((c) => c.type === 'comments').map(section)}
        </>
      ) : null}
      {group === 'time' ? (
        <View className="px-4 py-3">
          <SurveyTimeBox
            title={t('surveyTime.title')}
            start={survey.start_ts}
            end={survey.stop_ts}
            readOnly={edit.locked}
            onChange={(which, ts) => {
              const key = comps[0]?.key;
              if (which === 'start') {
                if (ts != null) write(() => (key ? writeComponent(owner, key, { start_ts: ts }) : updateSurvey(id, { startTs: ts })));
              } else if (key) write(() => writeComponent(owner, key, { stop_ts: ts }));
            }}
          />
        </View>
      ) : null}
      {group === 'space' ? (
        // The template's 空間資料 modules, each with its 必填未填 line (modules since 2026-10-04).
        <View className="px-4 py-3">
          {comps.map((c) => {
            const missingLine = <RequiredMissingLine problems={instanceProblems(c, data.surveyValues[c.key] ?? {})} />;
            switch (c.type) {
              case 'centre':
                return (
                  <View key={c.key}>
                    {missingLine}
                    <CentreLocationCard
                      required={false}
                      // Previews: the page scrolls over them (asked 2026-10-04).
                      mapPreview
                      lat={survey.lat}
                      lng={survey.lng}
                      accuracy={survey.accuracy}
                      elevation={survey.elevation_m}
                      boundary={boundary}
                      onCapture={() => void captureGps()}
                      // Hand-placed arrives as null; an undo restores the measured value that was there before.
                      onPlace={(lat, lng, accuracy) => write(() => updateSurvey(id, { lat, lng, accuracy }))}
                      onDrawBoundary={() => router.push(`/(tabs)/map?draw=Polygon&survey=${id}` as Href)}
                    />
                  </View>
                );
              case 'site':
                return (
                  <View key={c.key}>
                    {missingLine}
                    <SiteRow name={site?.name ?? null} onPress={() => (edit.refuse() ? undefined : setSiteOpen(true))} />
                  </View>
                );
              case 'track':
                return (
                  <View key={c.key}>
                    {missingLine}
                    <TrackControlView
                      mapPreview
                      label={t('surveyForm.track')}
                      segments={segments}
                      recording={recording}
                      livePoints={livePoints}
                      disabled={survey.status === 'done'}
                      onStart={() => void startTrack()}
                      onPause={() => {
                        pauseRecording();
                        onChanged();
                      }}
                    />
                  </View>
                );
              default:
                return null;
            }
          })}
        </View>
      ) : null}
      {group === 'method' ? comps.map(section) : null}
      <View className="h-12" />

      <SurveyorAssignSheet
        visible={surveyorOpen}
        current={survey.investigators ?? ''}
        onCancel={() => setSurveyorOpen(false)}
        onAssign={(v) => {
          setSurveyorOpen(false);
          write(() => updateSurvey(id, { investigators: v || null }));
        }}
      />
      <SiteAssignSheet
        visible={siteOpen}
        currentSiteId={survey.site_id}
        preferredProjectId={survey.project_id}
        onCancel={() => setSiteOpen(false)}
        onAssign={(siteId) => {
          setSiteOpen(false);
          write(() => updateSurvey(id, { siteId }));
          toast(siteId === null ? t('session.siteUnassigned') : t('session.siteAssigned'));
        }}
        onCreateNew={(drawType) => {
          setSiteOpen(false);
          router.push(`/(tabs)/map?draw=${drawType}&survey=${id}` as Href);
        }}
      />
      <NotesEditModal
        visible={notesComp != null}
        initialValue={notesComp && typeof data.surveyValues[notesComp.key]?.notes === 'string' ? (data.surveyValues[notesComp.key].notes as string) : ''}
        title={notesComp ? label(notesComp) : undefined}
        onCancel={() => setNotesKey(null)}
        onSave={(text) => {
          const key = notesKey;
          setNotesKey(null);
          if (key) write(() => writeComponent(owner, key, { notes: text || null }));
        }}
      />
    </View>
  );
}

/** The survey's 地理樣區, as the project row is drawn. */
function SiteRow({ name, onPress }: { name: string | null; onPress: () => void }) {
  const c = useThemeColors();
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className="mt-3 flex-row items-center rounded-lg border border-gray-200 bg-card px-3 py-3 active:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:active:bg-gray-800"
    >
      <Ionicons name="map-outline" size={18} color={c.ink2} />
      <View className="ml-2 flex-1">
        <Text className="text-xs text-gray-500 dark:text-gray-400">{t('menu.sites')}</Text>
        <Text className={`text-sm ${name ? 'text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'}`} numberOfLines={1}>
          {name ?? t('session.assignOrCreateSite')}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={c.ink3} />
    </Pressable>
  );
}
