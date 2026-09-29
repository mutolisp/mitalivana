/**
 * Scans of one paper form (Form 1, 2, 3 or 6-S; model/formScans): photos or
 * PDF, any number of files. All four sit together under the base-data tab's
 * 表單掃描檔 row (BaseDataTab). Exported under the form's sheet 01_
 * identifier (export/sheetRows, bundleExport).
 */
import { useTranslation } from 'react-i18next';
import { Alert, Text, View } from 'react-native';
import { resolveAssetUri } from '~/lib/bundleExport';
import { errText } from '~/lib/errText';
import { pickFiles, photoRef } from '~/lib/fileAttach';
import { captureEnvPhoto, pickPhotos } from '~/lib/photoCapture';
import { updateGloriaSurvey } from '../db';
import { SCAN_FORMS, type ScanForm } from '../model/formScans';
import { parseFiles, type FileRef } from '../model/loggers';
import type { SurveyState } from '../useSurvey';
import { FileList } from './LoggerForm';
import { Btn, Card, Label } from './ui';

const TITLE_KEY: Record<ScanForm, string> = {
  '1': 'gloria.scans.form1',
  '2': 'gloria.list.quadrats',
  '3': 'gloria.list.sas',
  '6S': 'gloria.list.squares',
};

export function FormScans({ state, reload, form }: { state: SurveyState; reload: () => void; form: ScanForm }) {
  const { t } = useTranslation();
  const column = SCAN_FORMS.find((f) => f.form === form)!.column;
  const files = parseFiles(state.survey[column]);
  const save = (next: FileRef[]) => {
    updateGloriaSurvey(state.survey.id, { [column]: next.length ? JSON.stringify(next) : null });
    reload();
  };
  // The picked copy keeps its real extension (png, heic); camera shots are jpg.
  const photoName = (i: number, uri = '') => `Form${form === '6S' ? '6-S' : form}-${i}.${/\.([A-Za-z0-9]{1,5})$/.exec(uri)?.[1]?.toLowerCase() ?? 'jpg'}`;
  const run = (f: () => Promise<FileRef[]>) =>
    void f()
      .then((added) => added.length && save([...files, ...added]))
      .catch((e) => Alert.alert(t('gloria.scans.fail'), errText(e)));

  return (
    <>
      <Label>{`Form ${form === '6S' ? '6-S' : form} · ${t(TITLE_KEY[form])} · ${t('gloria.scans.title')}`}</Label>
      <Card className="gap-2 p-3">
        <Text className="text-xs text-gray-500 dark:text-gray-400">{t('gloria.scans.hint')}</Text>
        <FileList files={files} editable resolve={resolveAssetUri} onChange={save} />
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Btn
              small
              label={t('gloria.scans.camera')}
              onPress={() => run(async () => {
                const u = await captureEnvPhoto();
                return u ? [photoRef(u, photoName(files.length + 1))] : [];
              })}
            />
          </View>
          <View className="flex-1">
            <Btn
              small
              label={t('gloria.scans.library')}
              onPress={() => run(async () => (await pickPhotos()).map((u, i) => photoRef(u, photoName(files.length + i + 1, u))))}
            />
          </View>
          <View className="flex-1">
            <Btn small label={t('gloria.scans.file')} onPress={() => run(pickFiles)} />
          </View>
        </View>
      </Card>
    </>
  );
}
