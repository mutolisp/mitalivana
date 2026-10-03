/**
 * The components of one owner (a survey, a unit or an occurrence), each in
 * its card: the input, what componentRules finds, and what the store refused.
 * Every change is written at once (surveyCore.writeComponent); a value the
 * store cannot hold is refused there and shown under its card. The host
 * reloads the values afterwards (`onChanged`).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from 'react-native';
import { componentProblems } from '~/survey/componentRules';
import { ComponentEditor, componentLabel } from '~/survey/components/editors/ComponentEditor';
import type { EditorContext } from '~/survey/components/editors/shared';
import { FormCard } from '~/survey/components/FormBits';
import type { ComponentOwner } from '~/survey/db/surveyCore';
import { addMedia, removeMedia, writeComponent } from '~/survey/db/surveys';
import { componentDef, type ComponentValues, type FieldValue } from '~/survey/registry';
import type { ComponentInstance } from '~/survey/template/types';
import { formErrorText } from './text';

export function ComponentCards({
  owner,
  instances,
  values,
  readOnly,
  context,
  onChanged,
  refuse,
}: {
  owner: ComponentOwner;
  instances: readonly ComponentInstance[];
  values: Readonly<Record<string, ComponentValues>>;
  readOnly: boolean;
  context?: Omit<EditorContext, 'onAddMedia' | 'onRemoveMedia'>;
  onChanged: () => void;
  /** Called instead of writing while read-only (a locked record says why). */
  refuse?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [refused, setRefused] = useState<Record<string, string>>({});
  const attempt = (key: string, run: () => void) => {
    if (readOnly) {
      refuse?.();
      return;
    }
    try {
      run();
      setRefused((r) => ({ ...r, [key]: '' }));
    } catch (e) {
      setRefused((r) => ({ ...r, [key]: formErrorText(t, e) }));
    }
    onChanged();
  };
  return (
    <>
      {instances.map((c) => {
        const def = componentDef(c.type);
        const v = values[c.key] ?? {};
        const problems = def ? componentProblems(def, c.params, c.level, c.key, v) : [];
        return (
          <FormCard key={c.key} title={componentLabel(t, i18n.language, c)}>
            <ComponentEditor
              instance={c}
              values={v}
              problems={problems}
              readOnly={readOnly}
              onChange={(patch: Record<string, FieldValue>) => attempt(c.key, () => writeComponent(owner, c.key, patch))}
              context={{
                ...context,
                onAddMedia: (uri) => attempt(c.key, () => void addMedia(owner, c.key, uri)),
                onRemoveMedia: (uri) => attempt(c.key, () => removeMedia(owner, c.key, uri)),
              }}
            />
            {refused[c.key] ? <Text className="text-xs text-alert dark:text-alert-dark">{refused[c.key]}</Text> : null}
          </FormCard>
        );
      })}
    </>
  );
}
