import { extractInvestigationConclusion } from '@mini-agent-run/debug-agent';
import { InvestigationRunSchema, type InvestigationConclusion, type InvestigationRun } from '@mini-agent-run/shared';

export type StoredRun = Omit<InvestigationRun, 'conclusion'> & { conclusion: string | null };

export function recoverStoredConclusion<T extends {
  status: InvestigationRun['status'];
  finalAnswer?: string | null;
  conclusion?: InvestigationConclusion | null;
}>(record: T): T {
  if (record.status !== 'completed' || record.conclusion != null || !record.finalAnswer) return record;
  const { cleanedAnswer, conclusion } = extractInvestigationConclusion(record.finalAnswer);
  return conclusion === null ? record : { ...record, finalAnswer: cleanedAnswer, conclusion };
}

export function decodeStoredRun(row: StoredRun) {
  return recoverStoredConclusion(InvestigationRunSchema.parse({
    ...row, conclusion: row.conclusion === null ? null : JSON.parse(row.conclusion),
  }));
}
