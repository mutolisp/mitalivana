/** Download one built-in checklist with progress; shared by the home prompt and the checklists page. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { downloadSpecies, fetchSpeciesManifest, type WebDatasetId } from '../host/speciesInstall';
import { formatBytes } from '../host/exportSize';
import { setSpeciesInstalled } from './bootStore';

export function useDatasetDownload(id: WebDatasetId) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Resolves true when the checklist was installed. */
  const go = async (): Promise<boolean> => {
    setBusy(true);
    try {
      const m = await fetchSpeciesManifest(id);
      await downloadSpecies(m, (done, total) => setStatus(t('web.home.speciesProgress', { done: formatBytes(done), total: formatBytes(total) })));
      setSpeciesInstalled(id, m.version);
      setStatus(null);
      return true;
    } catch (e) {
      setStatus(t('web.home.speciesFailed', { msg: e instanceof Error ? e.message : String(e) }));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { go, busy, status };
}
