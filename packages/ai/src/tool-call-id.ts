import { ToolCallIdSchema } from '@mini-agent-run/shared';
import { createHash } from 'node:crypto';

const maxIdLength = 40;

export function normalizeToolCallId(rawId: string | undefined, index: number, used: Set<string>): string {
  const position = Number.isSafeInteger(index) && index >= 0 ? index : 0;
  const raw = rawId || `call_${position}`;
  let id = raw;
  if (id.length > maxIdLength || !ToolCallIdSchema.safeParse(id).success) {
    const clean = raw.replace(/[^A-Za-z0-9_-]/g, '_');
    const prefix = clean.startsWith('tc_') ? clean : 'tc_' + clean;
    if (clean !== raw || prefix.length > maxIdLength) {
      const hash = createHash('sha256').update(raw).digest('hex').slice(0, 8);
      id = prefix.slice(0, maxIdLength - hash.length - 1) + '_' + hash;
    } else {
      id = prefix === 'tc_' ? prefix + `call_${position}` : prefix;
    }
  }
  const base = id;
  for (let duplicate = 0; used.has(id); duplicate++) {
    const suffix = duplicate === 0 ? `_${position}` : `_${position}_${duplicate}`;
    id = base.slice(0, maxIdLength - suffix.length) + suffix;
  }
  used.add(id);
  return id;
}
