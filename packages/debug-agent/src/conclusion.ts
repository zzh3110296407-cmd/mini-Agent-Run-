import { InvestigationConclusionSchema, type InvestigationConclusion } from '@mini-agent-run/shared';

export interface ExtractedInvestigationConclusion {
  conclusion: InvestigationConclusion | null;
  cleanedAnswer: string;
}

type Fence = { start: number; bodyStart: number; marker: string; label: string };
type Block = Fence & { bodyEnd: number; end: number; nextLine: number; closed: boolean };

function findBlocks(answer: string) {
  const blocks: Block[] = [];
  let open: Fence | undefined;
  for (let start = 0; start < answer.length;) {
    const newline = answer.indexOf('\n', start);
    const nextLine = newline === -1 ? answer.length : newline + 1;
    const lineEnd = newline === -1 ? nextLine : newline - (answer[newline - 1] === '\r' ? 1 : 0);
    const line = answer.slice(start, lineEnd).trimEnd();
    const match = /^[ \t]*(\x60{3,}|~{3,})(.*)$/.exec(line);
    const marker = match?.[1];
    const rest = match?.[2]?.trim() ?? '';
    if (marker) {
      if (!open) {
        open = { start, bodyStart: nextLine, marker, label: rest.split(/\s+/, 1)[0]?.toLowerCase() ?? '' };
      } else if (!rest && marker[0] === open.marker[0] && marker.length >= open.marker.length) {
        blocks.push({ ...open, bodyEnd: start, end: lineEnd, nextLine, closed: true });
        open = undefined;
      }
    }
    start = nextLine;
  }
  if (open) blocks.push({ ...open, bodyEnd: answer.length, end: answer.length, nextLine: answer.length, closed: false });
  return blocks;
}

function omitNullTerminationReason(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || !('threeStateAssessment' in payload)) return payload;
  const assessment = payload.threeStateAssessment;
  if (typeof assessment !== 'object' || assessment === null
      || !('terminationReason' in assessment) || assessment.terminationReason !== null) return payload;
  const observedSignals: Record<string, unknown> = { ...assessment };
  delete observedSignals.terminationReason;
  return { ...payload, threeStateAssessment: observedSignals };
}

function parseBlock(answer: string, block: Block): InvestigationConclusion | undefined {
  try {
    const payload: unknown = JSON.parse(answer.slice(block.bodyStart, block.bodyEnd));
    const result = InvestigationConclusionSchema.safeParse(omitNullTerminationReason(payload));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function normalizeProseSpacing(text: string): string {
  return text.replace(/(\r?\n)(?:[ \t]*\r?\n){2,}/g, '$1$1');
}

function extracted(
  answer: string, selected: Block, blocks: readonly Block[], conclusion: InvestigationConclusion,
): ExtractedInvestigationConclusion {
  const parts: string[] = [];
  let offset = 0;
  let prose = '';
  for (const block of blocks) {
    prose += answer.slice(offset, block.start);
    if (block === selected) {
      offset = block.nextLine;
      continue;
    }
    const normalized = normalizeProseSpacing(prose);
    parts.push(parts.length ? normalized : normalized.trimStart(), answer.slice(block.start, block.end));
    prose = '';
    offset = block.end;
  }
  const tail = normalizeProseSpacing(prose + answer.slice(offset));
  parts.push(parts.length ? tail.trimEnd() : tail.trim());
  const cleanedAnswer = parts.join('');
  return { conclusion, cleanedAnswer: cleanedAnswer || conclusion.summary };
}

export function extractInvestigationConclusion(rawAnswer: string): ExtractedInvestigationConclusion {
  const blocks = findBlocks(rawAnswer);
  const closed = blocks.filter(({ closed }) => closed).reverse();
  for (const block of closed) {
    if (block.label !== 'investigation-conclusion') continue;
    const conclusion = parseBlock(rawAnswer, block);
    if (conclusion) return extracted(rawAnswer, block, blocks, conclusion);
  }
  const fallback = closed.find(({ label }) => label === 'json');
  if (fallback) {
    const conclusion = parseBlock(rawAnswer, fallback);
    if (conclusion) return extracted(rawAnswer, fallback, blocks, conclusion);
  }
  return { conclusion: null, cleanedAnswer: rawAnswer };
}
