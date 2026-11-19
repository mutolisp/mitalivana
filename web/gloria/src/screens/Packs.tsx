/**
 * Checklists: the built-in Taiwan and Japan vascular plant checklists
 * (download / update), then country packs — GBIF species lists that make a
 * country's plants searchable offline elsewhere. Two ways in: request the
 * list from GBIF with the user's GBIF account (then download the finished
 * file and import it, see gbif/packs.ts), or import a species list already
 * downloaded from gbif.org. Strings are mobile's regionPacks.* where the
 * meaning is the same.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Linking, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams } from '../router/router';
import { Button } from '~/components/ui/Button';
import { COUNTRIES, countryName, type Country } from '~/lib/countries';
import { createPack, deletePack, invalidatePackCache, listPacks, updatePack, type RegionPack } from '~/db/regionpacks';
import { useSettings } from '~/stores/settings';
import { useToast } from '~/stores/toast';
import { chooseFiles } from '../host/pickFiles';
import {
  drivePack, GbifError, importPackFile, isPolling, packFileUrl, packPageUrl, requestPackDownload, usePackLive, type PackLive,
} from '../gbif/packs';
import { speciesUpdateAvailable, WEB_DATASETS_LIST, type WebDatasetId } from '../host/speciesInstall';
import { useBoot } from '../shell/bootStore';
import { useDatasetDownload } from '../shell/useDatasetDownload';

const FILE_TYPES = '.zip,.csv,.tsv,.txt,application/zip,text/plain,text/csv,text/tab-separated-values';

const input = 'rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink dark:border-line-dark dark:bg-paper-dark dark:text-gray-100';

export default function Packs() {
  const { t, i18n } = useTranslation();
  const [packs, setPacks] = useState<RegionPack[]>(listPacks);
  const reload = useCallback(() => setPacks(listPacks()), []);
  useFocusEffect(reload);
  const live = usePackLive((s) => s.byPack);
  // Status changes from the poller show up here.
  useEffect(reload, [live, reload]);
  // Resume polling for requests still waiting at GBIF (after a reload, say).
  useEffect(() => {
    for (const p of listPacks()) if (p.gbif_download_key && (p.status === 'requested' || p.status === 'running')) drivePack(p.id);
  }, []);
  // From the first-run prompt: /packs?country=AT opens the add form for it.
  const { country: preset } = useLocalSearchParams<{ country?: string }>();
  const presetCountry = COUNTRIES.find((c) => c.code === preset) ?? null;
  const [adding, setAdding] = useState(!!presetCountry);
  const [retrying, setRetrying] = useState<RegionPack | null>(null);

  const importInto = async (pack: RegionPack, isNew: boolean) => {
    const [file] = await chooseFiles({ accept: FILE_TYPES });
    if (!file) {
      if (isNew) deletePack(pack.id);
      reload();
      return;
    }
    try {
      const n = await importPackFile(pack.id, new Uint8Array(await file.arrayBuffer()));
      useToast.getState().show(t('web.packs.imported', { count: n, name: countryName(pack.country_code, i18n.language) }));
    } catch (e) {
      if (isNew) deletePack(pack.id);
      Alert.alert(t('web.packs.importFailed'), t('web.packs.notSpeciesList', { msg: String((e as Error)?.message ?? e) }));
    }
    reload();
  };

  const remove = (pack: RegionPack) =>
    Alert.alert(t('regionPacks.deleteTitle'), t('regionPacks.deleteMsg', { name: countryName(pack.country_code, i18n.language) }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          deletePack(pack.id);
          invalidatePackCache();
          reload();
        },
      },
    ]);

  return (
    <ScrollView contentContainerClassName="gap-4 p-4 pb-24">
      <Stack.Screen options={{ title: t('web.packs.title') }} />
      <Text className="text-xs font-semibold uppercase tracking-wide text-ink-3 dark:text-gray-400">{t('web.packs.builtinTitle')}</Text>
      <View className="overflow-hidden rounded-card border border-line bg-card dark:border-line-dark dark:bg-card-dark">
        {WEB_DATASETS_LIST.map((id, i) => (
          <BuiltinRow key={id} id={id} first={i === 0} />
        ))}
      </View>

      <Text className="mt-2 text-xs font-semibold uppercase tracking-wide text-ink-3 dark:text-gray-400">{t('web.packs.packsTitle')}</Text>
      <Text className="text-sm text-ink-2 dark:text-gray-300">{t('web.packs.intro')}</Text>
      <Text className="text-xs text-ink-3 dark:text-gray-400">{t('regionPacks.qualityNote')}</Text>

      {packs.length === 0 && !adding ? <Text className="text-sm text-ink-2 dark:text-gray-300">{t('regionPacks.empty')}</Text> : null}
      {packs.map((p) => (
        <PackCard key={p.id} pack={p} live={live[p.id]} onImport={() => void importInto(p, false)} onRetry={() => setRetrying(p)} onDelete={() => remove(p)} />
      ))}

      {retrying ? (
        <RequestForm
          country={retrying.country_code}
          onCancel={() => setRetrying(null)}
          onDone={() => {
            setRetrying(null);
            reload();
          }}
          pack={retrying}
        />
      ) : adding ? (
        <AddPack
          initial={presetCountry}
          onCancel={() => setAdding(false)}
          onImportFile={(c) => {
            setAdding(false);
            void importInto(createPack(c.code, []), true);
          }}
          onRequested={() => {
            setAdding(false);
            reload();
          }}
        />
      ) : (
        <Button variant="primary" label={t('regionPacks.add')} onPress={() => setAdding(true)} />
      )}
    </ScrollView>
  );
}

/** A built-in checklist: installed version, download or update. */
function BuiltinRow({ id, first }: { id: WebDatasetId; first: boolean }) {
  const { t } = useTranslation();
  const version = useBoot()?.species[id];
  const { go, busy, status } = useDatasetDownload(id);
  const [update, setUpdate] = useState(false);
  useEffect(() => {
    let alive = true;
    if (version) void speciesUpdateAvailable(id).then((m) => alive && setUpdate(!!m));
    return () => {
      alive = false;
    };
  }, [id, version]);
  return (
    <View className={`gap-1 px-4 py-3 ${first ? '' : 'border-t border-line dark:border-line-dark'}`}>
      <View className="flex-row items-center gap-3">
        <View className="flex-1">
          <Text className="text-sm font-semibold text-ink dark:text-gray-100">{t(`web.start.ds.${id}`)}</Text>
          <Text className="text-xs text-ink-3 dark:text-gray-400">
            {version ? t('web.packs.installed', { version: version.split('+')[0] }) : t('web.packs.notInstalled')}
          </Text>
        </View>
        {!version || update ? (
          <Button
            variant={version ? 'secondary' : 'primary'}
            icon="download-outline"
            label={version ? t('web.packs.update') : t('web.home.speciesDownload')}
            onPress={() => void go().then((ok) => ok && setUpdate(false))}
            disabled={busy}
          />
        ) : null}
      </View>
      {status ? <Text className="text-xs text-ink-2 dark:text-gray-300">{status}</Text> : null}
    </View>
  );
}

function statusLine(t: (k: string, o?: Record<string, unknown>) => string, p: RegionPack, live: PackLive | undefined): string {
  if (live?.phase === 'importing') return t('regionPacks.importing', { done: live.done, total: live.total });
  if (live?.phase === 'fileReady') return t('web.packs.fileReady');
  if (live?.phase === 'waiting') {
    const s = Math.max(1, Math.round((Date.now() - live.since) / 1000));
    const elapsed = s >= 60 ? t('regionPacks.elapsedMin', { n: Math.floor(s / 60) }) : t('regionPacks.elapsedSec', { n: s });
    return t('web.packs.waiting', { status: live.gbifStatus, elapsed });
  }
  if (p.status === 'ready') return t('regionPacks.readyCount', { count: p.species_count ?? 0 });
  if (p.status === 'failed') return `${t('regionPacks.failed')}${p.error ? `：${p.error}` : ''}`;
  return t('web.packs.pending');
}

function PackCard({
  pack: p, live, onImport, onRetry, onDelete,
}: { pack: RegionPack; live: PackLive | undefined; onImport: () => void; onRetry: () => void; onDelete: () => void }) {
  const { t, i18n } = useTranslation();
  const busy = live?.phase === 'importing';
  const waiting = !!p.gbif_download_key && (p.status === 'requested' || p.status === 'running');
  return (
    <View className="gap-2 rounded-card border border-line bg-card p-4 dark:border-line-dark dark:bg-card-dark">
      <View className="flex-row items-baseline gap-2">
        <Text className="flex-1 text-base font-semibold text-ink dark:text-gray-100">
          {countryName(p.country_code, i18n.language)} <Text className="font-mono text-xs text-ink-3 dark:text-gray-400">{p.country_code}</Text>
        </Text>
      </View>
      <Text className={`text-sm ${p.status === 'failed' ? 'text-alert dark:text-alert-dark' : 'text-ink-2 dark:text-gray-300'}`}>{statusLine(t, p, live)}</Text>
      {live?.phase === 'fileReady' ? <Text className="text-xs text-ink-3 dark:text-gray-400">{t('web.packs.fileReadyHint')}</Text> : null}
      {busy ? null : (
        <View className="flex-row flex-wrap gap-2">
          {live?.phase === 'fileReady' && p.gbif_download_key ? (
            <Button variant="primary" icon="download-outline" label={t('web.packs.downloadFile')} onPress={() => void Linking.openURL(packFileUrl(p.gbif_download_key!))} />
          ) : null}
          {p.status !== 'ready' ? (
            <Button variant={live?.phase === 'fileReady' ? 'primary' : 'secondary'} icon="document-attach-outline" label={t('web.packs.importFile')} onPress={onImport} />
          ) : null}
          {waiting && !live && !isPolling(p.id) ? <Button variant="secondary" label={t('regionPacks.resume')} onPress={() => drivePack(p.id)} /> : null}
          {p.status === 'failed' ? <Button variant="secondary" label={t('regionPacks.retry')} onPress={onRetry} /> : null}
          {p.gbif_download_key ? (
            <Button variant="ghost" label={t('regionPacks.openGbifWeb')} onPress={() => void Linking.openURL(packPageUrl(p.gbif_download_key!))} />
          ) : null}
          <Button variant="ghost" icon="trash-outline" label={t('common.delete')} onPress={onDelete} />
        </View>
      )}
    </View>
  );
}

function AddPack({
  initial, onCancel, onImportFile, onRequested,
}: { initial?: Country | null; onCancel: () => void; onImportFile: (c: Country) => void; onRequested: () => void }) {
  const { t, i18n } = useTranslation();
  const [q, setQ] = useState('');
  const [country, setCountry] = useState<Country | null>(initial ?? null);
  const [requesting, setRequesting] = useState(false);
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    const all = COUNTRIES.filter((c) => !s || c.code.toLowerCase() === s || c.en.toLowerCase().includes(s) || c.zh.includes(q.trim()));
    return all.slice(0, 40);
  }, [q]);

  if (country && requesting) return <RequestForm country={country.code} onCancel={() => setRequesting(false)} onDone={onRequested} />;

  if (country) {
    return (
      <View className="gap-3 rounded-card border border-line bg-card p-4 dark:border-line-dark dark:bg-card-dark">
        <Text className="text-base font-semibold text-ink dark:text-gray-100">{countryName(country.code, i18n.language)}</Text>
        <Text className="text-xs text-ink-3 dark:text-gray-400">{t('web.packs.scope')}</Text>
        <Button variant="primary" icon="cloud-download-outline" label={t('web.packs.request')} onPress={() => setRequesting(true)} />
        <Text className="text-xs text-ink-3 dark:text-gray-400">{t('web.packs.requestHint')}</Text>
        <Button variant="secondary" icon="document-attach-outline" label={t('web.packs.importFile')} onPress={() => onImportFile(country)} />
        <Text className="text-xs text-ink-3 dark:text-gray-400">{t('web.packs.importHint')}</Text>
        <Button variant="ghost" label={t('common.cancel')} onPress={() => setCountry(null)} />
      </View>
    );
  }

  return (
    <View className="gap-2 rounded-card border border-line bg-card p-4 dark:border-line-dark dark:bg-card-dark">
      <Text className="text-base font-semibold text-ink dark:text-gray-100">{t('regionPacks.pickCountry')}</Text>
      <TextInput className={input} value={q} onChangeText={setQ} placeholder={t('regionPacks.searchCountry')} autoFocus />
      <View className="max-h-72 overflow-y-auto">
        {matches.map((c) => (
          <Pressable
            key={c.code}
            onPress={() =>
              // Taiwan and Japan have built-in checklists (top of this page), as on mobile.
              c.code === 'TW' || c.code === 'JP'
                ? Alert.alert(t('regionPacks.builtinTitle'), t('web.packs.builtinUse', { country: countryName(c.code, i18n.language) }))
                : setCountry(c)
            }
            className="flex-row gap-3 border-t border-line px-1 py-2 active:bg-disc dark:border-line-dark"
          >
            <Text className="w-8 font-mono text-xs text-ink-3 dark:text-gray-400">{c.code}</Text>
            <Text className="flex-1 text-sm text-ink dark:text-gray-100">{countryName(c.code, i18n.language)}</Text>
          </Pressable>
        ))}
      </View>
      <Button variant="ghost" label={t('common.cancel')} onPress={onCancel} />
    </View>
  );
}

/** GBIF account form for a new pack (or a failed one, retried). */
function RequestForm({ country, pack, onCancel, onDone }: { country: string; pack?: RegionPack; onCancel: () => void; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const settings = useSettings();
  const [user, setUser] = useState(settings.gbif_username);
  const [pass, setPass] = useState('');
  const [email, setEmail] = useState(settings.gbif_notify_email);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const username = user.trim();
    // The API takes the username only, never the email (mobile regionpacks.tsx).
    if (username.includes('@')) {
      setError(t('regionPacks.emailNotAllowedMsg'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const key = await requestPackDownload(country, username, pass, email.trim() || undefined);
      settings.set('gbif_username', username);
      settings.set('gbif_notify_email', email.trim());
      const target = pack ?? createPack(country, []);
      updatePack(target.id, { gbif_download_key: key, gbif_doi: null, status: 'requested', error: null });
      useToast.getState().show(t('regionPacks.requested'));
      drivePack(target.id);
      onDone();
    } catch (e) {
      setError(e instanceof GbifError && e.status === 401 ? t('regionPacks.badCredentials') : `${t('regionPacks.requestFailed')}：${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(false);
      setPass('');
    }
  };

  return (
    <View className="gap-2 rounded-card border border-line bg-card p-4 dark:border-line-dark dark:bg-card-dark">
      <Text className="text-base font-semibold text-ink dark:text-gray-100">
        {countryName(country, i18n.language)} · {t('web.packs.request')}
      </Text>
      <Text className="text-xs text-ink-2 dark:text-gray-300">{t('regionPacks.gbifUserTitle')}</Text>
      <TextInput className={input} value={user} onChangeText={setUser} autoCapitalize="none" autoComplete="username" placeholder={t('web.packs.usernamePh')} />
      <Text className="text-xs text-ink-2 dark:text-gray-300">{t('regionPacks.gbifPassTitle')}</Text>
      <TextInput className={input} value={pass} onChangeText={setPass} secureTextEntry autoComplete="current-password" />
      <Text className="text-xs text-ink-3 dark:text-gray-400">{t('web.packs.passwordNotSaved')}</Text>
      <Text className="text-xs text-ink-2 dark:text-gray-300">{t('regionPacks.notifyEmailTitle')}</Text>
      <TextInput className={input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
      <Text className="text-xs text-ink-3 dark:text-gray-400">{t('web.packs.notifyHint')}</Text>
      {error ? <Text className="text-sm text-alert dark:text-alert-dark">{error}</Text> : null}
      <View className="flex-row gap-2">
        <Button variant="primary" label={t('regionPacks.startDownload')} onPress={() => void submit()} disabled={busy || !user.trim() || !pass} />
        <Button variant="ghost" label={t('common.cancel')} onPress={onCancel} />
      </View>
      <Pressable onPress={() => void Linking.openURL('https://www.gbif.org/user/profile')}>
        <Text className="text-xs text-accent underline dark:text-emerald-400">{t('web.packs.register')}</Text>
      </Pressable>
    </View>
  );
}
