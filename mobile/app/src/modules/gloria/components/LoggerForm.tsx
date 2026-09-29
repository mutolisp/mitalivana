/**
 * One temperature-logger visit (Form 4): per direction, the loggers read out
 * (carried from the previous visit) and the loggers installed now. Each
 * logger is a one-line summary that opens into its fields. Rows are render
 * functions, not components, so a reload keeps the focused field (as
 * PointsForm).
 */
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';
import { showActionSheet } from '~/components/ActionSheet';
import { DateTimeField } from '~/components/DateTimeField';
import { PhotoGrid, PhotoViewerModal } from '~/components/PhotoGrid';
import { SurveyorAssignSheet } from '~/components/SurveyorAssignSheet';
import { isoStamp } from '~/lib/datetime';
import { errText } from '~/lib/errText';
import { pickFiles, shareAttached } from '~/lib/fileAttach';
import { captureEnvPhoto, pickPhotos } from '~/lib/photoCapture';
import { addInstall, addReadout, deleteLogger, updateLogger, type GloriaLogger } from '../loggerDb';
import {
  LOGGER_DIRECTIONS,
  LOGGER_FLAGS,
  loggerQuadrats,
  parseFiles,
  parseFlags,
  utcDiffHours,
  type FileRef,
  type LoggerFlag,
} from '../model/loggers';
import { RANGES } from '../model/ranges';
import type { Direction } from '../model/units';
import { Btn, Card, Chip, NumField } from './ui';
import { useThemeColors } from '~/theme/colors';
import { CheckboxMark } from '~/components/ui/Checkbox';

const INPUT =
  'flex-1 rounded-md border border-gray-300 bg-card px-2 py-1.5 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100';

/** Files attached to a logger or a visit: tap to open or share, remove from the menu. */
export function FileList({
  files,
  onChange,
  editable,
  resolve,
}: {
  files: FileRef[];
  onChange: (next: FileRef[]) => void;
  editable: boolean;
  resolve: (uri: string) => Promise<string | null>;
}) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const menu = async (f: FileRef, i: number) => {
    const idx = await showActionSheet({
      title: f.name,
      cancelLabel: t('common.cancel'),
      options: [{ label: t('gloria.logger.fileOpen') }, ...(editable ? [{ label: t('gloria.logger.fileRemove'), destructive: true }] : [])],
    });
    if (idx === 0) shareAttached(f, resolve).catch((e) => Alert.alert(t('gloria.logger.fileFail'), errText(e)));
    if (idx === 1) onChange(files.filter((_, k) => k !== i));
  };
  return (
    <View className="gap-1">
      {files.map((f, i) => (
        <Pressable key={`${f.uri}-${i}`} onPress={() => void menu(f, i)} className="flex-row items-center gap-1.5 py-0.5">
          <Ionicons name={/\.pdf$/i.test(f.name) ? 'document-text-outline' : /\.(jpe?g|png|heic|webp)$/i.test(f.name) ? 'image-outline' : 'document-outline'} size={16} color={c.accentPressed} />
          <Text className="flex-1 text-sm text-accent-700 dark:text-accent-300" numberOfLines={1}>
            {f.name}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * Researchers picked from the surveyor list (設定 → 調查者), as the survey's.
 * `inherited` is what an empty value stands for (a logger's empty value means
 * the visit's researchers); picking exactly that stores nothing.
 */
export function ResearcherPick({
  label,
  value,
  inherited,
  editable,
  onChange,
}: {
  label: string;
  value: string | null;
  inherited?: string | null;
  editable: boolean;
  onChange: (v: string | null) => void;
}) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  return (
    <View className="flex-row items-center gap-2">
      <Text className="w-20 text-xs text-gray-500 dark:text-gray-400">{label}</Text>
      <Pressable
        disabled={!editable}
        onPress={() => setPicking(true)}
        accessibilityRole="button"
        accessibilityLabel={label}
        className="flex-1 rounded-md border border-gray-300 bg-card px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900"
      >
        <Text className={`text-sm ${value ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400'}`} numberOfLines={2}>
          {value || (inherited ? t('gloria.logger.byVisit', { names: inherited }) : t('gloria.times.byNone'))}
        </Text>
      </Pressable>
      <SurveyorAssignSheet
        visible={picking}
        current={value ?? inherited ?? ''}
        onCancel={() => setPicking(false)}
        onAssign={(v) => {
          setPicking(false);
          const next = v.trim() && v !== inherited ? v : null;
          if (next !== value) onChange(next);
        }}
      />
    </View>
  );
}

export function LoggerForm({
  visitId,
  visitTs,
  loggers,
  researchers,
  editable,
  reload,
  resolve,
}: {
  visitId: number;
  /** The visit's day: what an old logger's unknown installation starts from. */
  visitTs: number;
  loggers: GloriaLogger[];
  /** The visit's researchers — what a logger's empty researcher stands for. */
  researchers: string | null;
  editable: boolean;
  reload: () => void;
  resolve: (uri: string) => Promise<string | null>;
}) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const [open, setOpen] = useState<Set<number>>(() => new Set(loggers.filter((l) => l.role === 'install' && !l.serial).map((l) => l.id)));
  const [viewer, setViewer] = useState<{ uris: string[]; i: number } | null>(null);
  const toggle = (id: number) => setOpen((s) => new Set(s.has(id) ? [...s].filter((x) => x !== id) : [...s, id]));
  const patch = (l: GloriaLogger, p: Parameters<typeof updateLogger>[1]) => {
    updateLogger(l.id, p);
    reload();
  };
  const add = (d: Direction, quadrat?: string, role: 'install' | 'readout' = 'install') => {
    const id = (role === 'install' ? addInstall : addReadout)(visitId, d, quadrat);
    setOpen((s) => new Set([...s, id]));
    reload();
  };

  const text = (l: GloriaLogger, col: 'label' | 'serial' | 'logger_type' | 'comments', label: string, multiline = false) => (
    <View className="flex-row items-center gap-2">
      <Text className="w-20 text-xs text-gray-500 dark:text-gray-400">{label}</Text>
      <TextInput
        key={`${l.id}-${col}-${l[col] ?? ''}`}
        defaultValue={l[col] ?? ''}
        editable={editable}
        multiline={multiline}
        autoCapitalize="none"
        onEndEditing={(e) => {
          const v = e.nativeEvent.text.trim() || null;
          if (v !== l[col]) patch(l, { [col]: v });
        }}
        accessibilityLabel={label}
        className={INPUT}
      />
    </View>
  );

  // The UTC difference follows the device's time zone at the installation time.
  const setWhen = (l: GloriaLogger, col: 'start_ts' | 'stop_ts', ts: number) =>
    patch(l, col === 'start_ts' ? { start_ts: ts, utc_diff_h: utcDiffHours(new Date(ts)) } : { stop_ts: ts });
  const when = (l: GloriaLogger, col: 'start_ts' | 'stop_ts', label: string, initial = () => Date.now(), emptyLabel?: string) => (
    <View className="flex-row items-start gap-2">
      <Text className="w-20 pt-2 text-xs text-gray-500 dark:text-gray-400">{label}</Text>
      {l[col] != null ? (
        <View className="flex-1 gap-1.5">
          <DateTimeField value={l[col] as number} mode="date" onChange={(ts) => editable && setWhen(l, col, ts)} />
          <DateTimeField value={l[col] as number} mode="time" format={(ts) => isoStamp(ts).slice(11, 16)} onChange={(ts) => editable && setWhen(l, col, ts)} />
        </View>
      ) : (
        <Pressable
          disabled={!editable}
          onPress={() => setWhen(l, col, initial())}
          className="flex-1 rounded-lg border border-dashed border-gray-300 px-3 py-2 dark:border-gray-600"
        >
          <Text className="text-xs text-gray-500 dark:text-gray-400">{emptyLabel ?? t('gloria.logger.setNow')}</Text>
        </Pressable>
      )}
    </View>
  );

  // A UTC difference that is the device zone's with the sign flipped is almost
  // always UTC+8 typed as 8 (Form 4 note 5 wants −8): ask before keeping it.
  const commitUtc = (l: GloriaLogger, v: number | null) => {
    const expected = utcDiffHours(new Date(l.start_ts ?? Date.now()));
    if (v == null || v === 0 || v !== -expected) return patch(l, { utc_diff_h: v });
    Alert.alert(t('gloria.logger.utcFlipTitle'), t('gloria.logger.utcFlipMsg', { value: v, expected }), [
      { text: t('gloria.logger.utcFlipKeep', { value: v }), onPress: () => patch(l, { utc_diff_h: v }) },
      { text: t('gloria.logger.utcFlipFix', { expected }), style: 'cancel', onPress: () => patch(l, { utc_diff_h: expected }) },
    ]);
  };

  const num = (l: GloriaLogger, col: 'dist11_m' | 'dist31_m' | 'utc_diff_h', label: string) => (
    <View className="flex-row items-center gap-2">
      <Text className="w-20 text-xs text-gray-500 dark:text-gray-400">{label}</Text>
      <NumField
        value={l[col]}
        onCommit={(v) => (col === 'utc_diff_h' ? commitUtc(l, v) : patch(l, { [col]: v }))}
        range={col === 'utc_diff_h' ? RANGES.utcDiff : RANGES.loggerDist}
        signed={col === 'utc_diff_h'}
        width={80}
        editable={editable}
        accessibilityLabel={label}
      />
    </View>
  );

  // Form 4 note 5 counts the other way from the zone name: UTC+8 is written −8.
  const utcHint = (l: GloriaLogger) => {
    const diff = l.utc_diff_h ?? utcDiffHours(new Date(l.start_ts ?? Date.now()));
    const zone = -diff;
    const fmt = (n: number) => `${n < 0 ? '−' : n > 0 ? '+' : '±'}${Math.abs(n)}`;
    return (
      <Text className="pl-[88px] text-[11px] text-gray-400">
        {t('gloria.logger.utcHint', { zone: `UTC${fmt(zone)}`, diff: fmt(diff).replace('+', '') })}
      </Text>
    );
  };

  const photo = (l: GloriaLogger, which: 'open' | 'closed') => {
    const uriCol = which === 'open' ? 'photo_open_uri' : 'photo_closed_uri';
    const tickCol = which === 'open' ? 'photo_open' : 'photo_closed';
    const uri = l[uriCol];
    const ticked = l[tickCol] === 1 || !!uri;
    return (
      <View className="gap-1">
        <Pressable
          disabled={!editable}
          onPress={() => patch(l, { [tickCol]: l[tickCol] === 1 ? null : 1 })}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: ticked }}
          className="flex-row items-center gap-2"
        >
          <CheckboxMark checked={ticked} />
          <Text className="text-xs text-gray-700 dark:text-gray-300">{t(which === 'open' ? 'gloria.logger.photoOpen' : 'gloria.logger.photoClosed')}</Text>
        </Pressable>
        <PhotoGrid
          photos={uri ? [uri] : []}
          onAdd={() => {
            if (!editable) return;
            void captureEnvPhoto().then((u) => u && patch(l, { [uriCol]: u }));
          }}
          onPickLibrary={editable ? () => void pickPhotos().then((us) => us[0] && patch(l, { [uriCol]: us[0] })) : undefined}
          onView={() => uri && setViewer({ uris: [uri], i: 0 })}
          onRemove={editable ? () => patch(l, { [uriCol]: null }) : undefined}
        />
      </View>
    );
  };

  const flags = (l: GloriaLogger) => {
    const on = parseFlags(l.flags);
    const flip = (f: LoggerFlag) => {
      const next = on.includes(f) ? on.filter((x) => x !== f) : [...on, f];
      patch(l, { flags: next.length ? JSON.stringify(next) : null });
      // A logger change: offer its replacement at the same position.
      if (f === 'LC' && !on.includes(f)) {
        Alert.alert(t('gloria.logger.lcAsk'), t('gloria.logger.lcAskMsg', { quadrat: l.quadrat }), [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('gloria.logger.add'), onPress: () => add(l.direction, l.quadrat) },
        ]);
      }
    };
    return (
      <View className="flex-row flex-wrap items-center">
        <Text className="w-20 text-xs text-gray-500 dark:text-gray-400">{t('gloria.logger.flags')}</Text>
        {LOGGER_FLAGS.map((f) => (
          <Chip key={f} label={t(`gloria.logger.flag.${f}`)} on={on.includes(f)} onPress={() => editable && flip(f)} />
        ))}
      </View>
    );
  };

  const files = (l: GloriaLogger) => (
    <View className="gap-1">
      <View className="flex-row items-center">
        <Text className="flex-1 text-xs text-gray-500 dark:text-gray-400">{t('gloria.logger.dataFiles')}</Text>
        {editable ? (
          <Btn
            small
            label={t('gloria.logger.pickFile')}
            onPress={() =>
              void pickFiles()
                .then((picked) => picked.length && patch(l, { data_files: JSON.stringify([...parseFiles(l.data_files), ...picked]) }))
                .catch((e) => Alert.alert(t('gloria.logger.fileFail'), errText(e)))
            }
          />
        ) : null}
      </View>
      <FileList
        files={parseFiles(l.data_files)}
        editable={editable}
        resolve={resolve}
        onChange={(next) => patch(l, { data_files: next.length ? JSON.stringify(next) : null })}
      />
    </View>
  );

  const row = (l: GloriaLogger) => {
    const expanded = open.has(l.id);
    const name = `${l.quadrat}${l.label ?? ''}`;
    const lc = parseFlags(l.flags).includes('LC');
    return (
      <View key={l.id} className="border-t border-gray-100 dark:border-gray-800">
        <Pressable
          onPress={() => toggle(l.id)}
          onLongPress={() => {
            if (!editable) return;
            Alert.alert(t('gloria.logger.remove'), name, [
              { text: t('common.cancel'), style: 'cancel' },
              {
                text: t('gloria.logger.removeGo'),
                style: 'destructive',
                onPress: () => {
                  deleteLogger(l.id);
                  reload();
                },
              },
            ]);
          }}
          className="flex-row items-center gap-2 px-3 py-2"
        >
          <Text className="w-14 text-sm font-semibold text-gray-900 dark:text-gray-100">{name}</Text>
          <Text className="flex-1 text-xs text-gray-600 dark:text-gray-300" numberOfLines={1}>
            {[l.serial || t('gloria.logger.noSerial'), l.logger_type, lc ? 'LC' : null, parseFiles(l.data_files).length ? t('gloria.logger.filesCount', { count: parseFiles(l.data_files).length }) : null]
              .filter(Boolean)
              .join(' · ')}
          </Text>
          <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={14} color={c.ink3} />
        </Pressable>
        {expanded ? (
          <View className="gap-2 px-3 pb-3">
            {text(l, 'label', t('gloria.logger.label'))}
            {text(l, 'serial', t('gloria.logger.serial'))}
            {text(l, 'logger_type', t('gloria.logger.type'))}
            <View className="flex-row flex-wrap items-center">
              <Text className="w-20 text-xs text-gray-500 dark:text-gray-400">{t('gloria.logger.position')}</Text>
              {loggerQuadrats(l.direction).map((q) => (
                <Chip key={q} label={q} on={l.quadrat === q} onPress={() => editable && patch(l, { quadrat: q })} />
              ))}
            </View>
            {l.role === 'readout' ? (
              <>
                {when(l, 'start_ts', t('gloria.logger.installedAt'), () => visitTs, t('gloria.logger.setVisitDay'))}
                {num(l, 'utc_diff_h', t('gloria.logger.utcDiff'))}
                {utcHint(l)}
                {num(l, 'dist11_m', 'Dist-11 (m)')}
                {num(l, 'dist31_m', 'Dist-31 (m)')}
                {when(l, 'stop_ts', t('gloria.logger.stop'))}
                {flags(l)}
              </>
            ) : (
              <>
                {when(l, 'start_ts', t('gloria.logger.start'))}
                {num(l, 'utc_diff_h', t('gloria.logger.utcDiff'))}
                {utcHint(l)}
                {num(l, 'dist11_m', 'Dist-11 (m)')}
                {num(l, 'dist31_m', 'Dist-31 (m)')}
                {photo(l, 'open')}
                {photo(l, 'closed')}
              </>
            )}
            <ResearcherPick
              label={t('gloria.logger.researcher')}
              value={l.researcher}
              inherited={researchers}
              editable={editable}
              onChange={(v) => patch(l, { researcher: v })}
            />
            {text(l, 'comments', t('gloria.logger.comments'), true)}
            {files(l)}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View className="gap-3">
      {LOGGER_DIRECTIONS.map((d) => {
        const mine = loggers.filter((l) => l.direction === d);
        const readout = mine.filter((l) => l.role === 'readout');
        const install = mine.filter((l) => l.role === 'install');
        return (
          <Card key={d}>
            <Text className="px-3 pt-2.5 text-base font-bold text-gray-900 dark:text-gray-100">{d}</Text>
            <Text className="px-3 pt-2 text-xs font-semibold text-gray-500 dark:text-gray-400">{t('gloria.logger.readout')}</Text>
            {readout.length ? readout.map(row) : <Text className="px-3 py-1.5 text-xs text-gray-400">{t('gloria.logger.noReadout')}</Text>}
            {editable ? (
              <View className="px-3 pb-1 pt-1">
                <Btn small label={t('gloria.logger.addReadout')} onPress={() => add(d, undefined, 'readout')} />
              </View>
            ) : null}
            <Text className="px-3 pt-2 text-xs font-semibold text-gray-500 dark:text-gray-400">{t('gloria.logger.install')}</Text>
            {install.map(row)}
            {editable ? (
              <View className="px-3 pb-3 pt-1">
                <Btn small label={t('gloria.logger.addLogger')} onPress={() => add(d)} />
              </View>
            ) : null}
          </Card>
        );
      })}
      {viewer ? <PhotoViewerModal photos={viewer.uris} index={viewer.i} onClose={() => setViewer(null)} /> : null}
    </View>
  );
}
