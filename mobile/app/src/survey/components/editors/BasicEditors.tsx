/**
 * The smaller inputs: photos and recordings (rows of fw_media, added and
 * removed by the host), comments, start and end time, investigators and
 * workers (the saved surveyor / identifier lists), a GNSS fix, and height.
 */
import { useDraftValue } from '~/lib/useDraftValue';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import { AudioClipList } from '~/components/AudioClipList';
import { DateTimeField } from '~/components/DateTimeField';
import { LabeledNumField } from '~/components/form/LabeledField';
import { PhotoGrid, PhotoViewerModal } from '~/components/PhotoGrid';
import { SurveyorAssignSheet } from '~/components/SurveyorAssignSheet';
import { Button } from '~/components/ui/Button';
import { errText } from '~/lib/errText';
import { captureFix } from '~/lib/gnssFix';
import { captureEnvPhoto, pickPhotos } from '~/lib/photoCapture';
import { useToast } from '~/stores/toast';
import { Field, TextBox } from '~/survey/components/FormBits';
import { ProblemLines, type EditorProps } from './shared';

const uris = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

export function PhotosEditor({ values, context, readOnly, problems }: EditorProps) {
  const toast = useToast((s) => s.show);
  const [viewing, setViewing] = useState<number | null>(null);
  const photos = uris(values.photos);
  const add = (list: string[]) => list.forEach((u) => context?.onAddMedia?.(u));
  return (
    <View className="gap-1">
      <PhotoGrid
        photos={photos}
        onAdd={() => (readOnly ? undefined : void captureEnvPhoto().then((u) => u && add([u])).catch((e) => toast(errText(e))))}
        onPickLibrary={readOnly ? undefined : () => void pickPhotos().then(add).catch((e) => toast(errText(e)))}
        onView={setViewing}
        onRemove={readOnly ? undefined : (uri) => context?.onRemoveMedia?.(uri)}
      />
      <PhotoViewerModal photos={photos} index={viewing} onClose={() => setViewing(null)} />
      <ProblemLines problems={problems} />
    </View>
  );
}

export function AudioEditor({ values, context, readOnly }: EditorProps) {
  const clips = uris(values.audio);
  // Locked: the recordings still play; nothing is recorded or removed.
  return (
    <AudioClipList
      clips={clips}
      onAdd={readOnly ? undefined : (u) => context?.onAddMedia?.(u)}
      onRemove={readOnly ? undefined : (u) => context?.onRemoveMedia?.(u)}
    />
  );
}

export function CommentsEditor({ values, onChange, readOnly }: EditorProps) {
  const { t } = useTranslation();
  // Written once typing pauses or the field is left, not letter by letter (2G-e).
  const draft = useDraftValue(text(values.notes), (v) => onChange({ notes: v || null }));
  return (
    <TextBox value={draft.value} onChange={draft.change} onBlur={draft.flush} accessibilityLabel={t('survey.component.comments')} multiline editable={!readOnly} />
  );
}

export function TimestampEditor({ values, onChange, problems, readOnly }: EditorProps) {
  const { t } = useTranslation();
  const start = num(values.start_ts);
  const stop = num(values.stop_ts);
  return (
    <View className="gap-2" pointerEvents={readOnly ? 'none' : 'auto'}>
      <Field label={t('survey.editor.timestamp.start')}>
        {/* Unset is shown as unset, not as the current time (2G-e). */}
        {start == null ? (
          <Pressable onPress={() => onChange({ start_ts: Date.now() })} accessibilityRole="button" className="self-start">
            <Text className="text-sm font-semibold text-accent-600 dark:text-accent-400">{t('survey.editor.timestamp.setStart')}</Text>
          </Pressable>
        ) : (
          <DateTimeField value={start} onChange={(v) => onChange({ start_ts: v })} />
        )}
      </Field>
      <Field label={t('survey.editor.timestamp.stop')}>
        {stop == null ? (
          <Pressable onPress={() => onChange({ stop_ts: Date.now() })} accessibilityRole="button" className="self-start">
            <Text className="text-sm font-semibold text-accent-600 dark:text-accent-400">{t('survey.editor.timestamp.setStop')}</Text>
          </Pressable>
        ) : (
          <DateTimeField value={stop} onChange={(v) => onChange({ stop_ts: v })} />
        )}
      </Field>
      <ProblemLines problems={problems} />
    </View>
  );
}

/** People from a saved list, as the comma-separated names records store. */
function PeopleRow({ label, value, kind, onChange, readOnly }: { label: string; value: string; kind: 'surveyor' | 'identifier'; onChange: (v: string | null) => void; readOnly?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Field label={label}>
      <Pressable
        onPress={() => setOpen(true)}
        disabled={readOnly}
        accessibilityRole="button"
        accessibilityLabel={`${label} ${value || t('survey.editor.people.none')}`}
        className="rounded-lg border border-gray-300 bg-card px-3 py-2 dark:border-gray-700 dark:bg-gray-900"
      >
        <Text className={`text-base ${value ? 'text-ink dark:text-gray-100' : 'text-ink-3 dark:text-gray-400'}`}>{value || t('survey.editor.people.none')}</Text>
      </Pressable>
      <SurveyorAssignSheet
        visible={open}
        current={value}
        kind={kind}
        onCancel={() => setOpen(false)}
        onAssign={(v) => {
          setOpen(false);
          onChange(v.trim() || null);
        }}
      />
    </Field>
  );
}

export function InvestigatorsEditor({ values, onChange, readOnly }: EditorProps) {
  const { t } = useTranslation();
  return <PeopleRow label={t('survey.component.investigators')} value={text(values.investigators)} kind="surveyor" onChange={(v) => onChange({ investigators: v })} readOnly={readOnly} />;
}

export function WorkersEditor({ instance, values, onChange, readOnly }: EditorProps) {
  const { t } = useTranslation();
  const roles = (Array.isArray(instance.params.roles) ? instance.params.roles : ['recorder']) as string[];
  return (
    <View className="gap-2">
      {roles.includes('recorder') ? (
        <PeopleRow label={t('survey.editor.workers.recorder')} value={text(values.recorded_by)} kind="surveyor" onChange={(v) => onChange({ recorded_by: v })} readOnly={readOnly} />
      ) : null}
      {roles.includes('identifier') ? (
        <PeopleRow label={t('survey.editor.workers.identifier')} value={text(values.identified_by)} kind="identifier" onChange={(v) => onChange({ identified_by: v })} readOnly={readOnly} />
      ) : null}
    </View>
  );
}

/** A GNSS fix for an occurrence (with its altitude) or a unit. */
export function LocationEditor({ instance, values, onChange, problems, readOnly }: EditorProps) {
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const [busy, setBusy] = useState(false);
  const lat = num(values.lat);
  const lng = num(values.lng);
  const acc = num(values.accuracy);
  const take = async () => {
    setBusy(true);
    try {
      const fix = await captureFix();
      if (!fix) return;
      onChange({
        lat: fix.lat,
        lng: fix.lng,
        accuracy: fix.accuracy,
        ...(instance.level === 'occurrence' && fix.altitudeM != null ? { elevation_m: Math.round(fix.altitudeM), elevation_source: 'gnss' } : {}),
      });
    } catch (e) {
      toast(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-2">
      <Text style={{ fontVariant: ['tabular-nums'] }} className="text-sm text-ink dark:text-gray-100">
        {lat != null && lng != null
          ? t('survey.editor.location.fix', { lat: lat.toFixed(6), lng: lng.toFixed(6), acc: acc == null ? '—' : Math.round(acc) })
          : t('survey.editor.location.none')}
      </Text>
      {!readOnly ? (
        <View className="flex-row gap-2">
          <Button label={t('survey.frame.takeFix')} icon="locate-outline" variant="secondary" loading={busy} onPress={() => void take()} className="flex-1" />
          {lat != null ? (
            <Button
              label={t('survey.editor.location.clear')}
              variant="secondary"
              onPress={() => onChange({ lat: null, lng: null, accuracy: null, ...(instance.level === 'occurrence' ? { elevation_m: null, elevation_source: null } : {}) })}
            />
          ) : null}
        </View>
      ) : null}
      <ProblemLines problems={problems} />
    </View>
  );
}

export function HeightEditor({ values, onChange, problems, readOnly }: EditorProps) {
  const { t } = useTranslation();
  return (
    <View pointerEvents={readOnly ? 'none' : 'auto'}>
      <LabeledNumField label={t('survey.component.height')} suffix="m" value={num(values.height_m)} min={0} onSave={(v) => onChange({ height_m: v })} />
      <ProblemLines problems={problems} />
    </View>
  );
}
