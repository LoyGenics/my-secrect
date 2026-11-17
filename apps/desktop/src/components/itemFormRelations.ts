import type { VaultRelation } from '../../../../packages/core/src/types';

/**
 * Relations to save from the form's checked target ids. The form only
 * edits WHICH items are related; an existing relation keeps its type
 * (and any other fields) untouched, and only newly checked targets get
 * the default `related_to`. Saving an unchanged item therefore never
 * rewrites typed relations (QA DEFECT-E1).
 */
export function buildRelations(initial: readonly VaultRelation[] | undefined, targetIds: readonly string[]): VaultRelation[] {
  const existing = new Map((initial ?? []).map((relation) => [relation.target_id, relation]));
  return targetIds.map((target_id) => existing.get(target_id) ?? { type: 'related_to', target_id });
}
