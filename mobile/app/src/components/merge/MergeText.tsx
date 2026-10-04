/**
 * A merge field's value as text, a scientific name in it in italics by its
 * rank (NameParts). Rendered inside a parent <Text>. Shared by the merge
 * review and ChangeList (merge log, record versions).
 */
import { NameParts } from '~/components/NameParts';
import { fmt, nameParts, type FmtContext } from '~/lib/mergeFormat';

/** A field's value as fmt() writes it, a scientific name in italics. `taxonId`: the row's taxon (mergeFormat.nameParts). */
export function MergeValue({ f, v, ctx, taxonId }: { f: string; v: unknown; ctx: FmtContext; taxonId?: unknown }) {
  const parts = nameParts(f, v, taxonId);
  return parts ? <NameParts parts={parts} /> : <>{fmt(f, v, ctx)}</>;
}
