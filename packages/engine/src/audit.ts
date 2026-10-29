/**
 * A values-free record of what Veil hid: counts per kind and per day, nothing else.
 * It answers "how much did Veil catch this month" for a person or a team without storing
 * a single value, so it is safe to keep, export and share.
 */
import { tally } from './describe.js';
import type { Finding } from './types.js';

/** { "2026-10-28": { "EMAIL": 3, "API_KEY": 1 } } */
export type AuditLog = Record<string, Record<string, number>>;

export const dayOf = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** Adds findings to the log in place and drops days older than `keepDays`. Returns the log. */
export function recordAudit(
  log: AuditLog,
  findings: readonly Pick<Finding, 'type'>[],
  date = new Date(),
  keepDays = 400,
): AuditLog {
  if (findings.length > 0) {
    const day = (log[dayOf(date)] ??= {});
    for (const [type, n] of Object.entries(tally(findings))) day[type] = (day[type] ?? 0) + n;
  }
  const cutoff = dayOf(new Date(date.getTime() - keepDays * 86_400_000));
  for (const d of Object.keys(log)) if (d < cutoff) delete log[d];
  return log;
}

/** Totals per kind over the last `days` days (today included). */
export function auditTotals(log: AuditLog, days = 30, now = new Date()): Record<string, number> {
  const from = dayOf(new Date(now.getTime() - (days - 1) * 86_400_000));
  const totals: Record<string, number> = {};
  for (const [d, counts] of Object.entries(log)) {
    if (d < from) continue;
    for (const [type, n] of Object.entries(counts)) totals[type] = (totals[type] ?? 0) + n;
  }
  return totals;
}
