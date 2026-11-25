import { InvestigationConclusionSchema, type InvestigationConclusion } from '@mini-agent-run/shared';

export interface ExtractedInvestigationConclusion {
  conclusion: InvestigationConclusion | null;
  cleanedAnswer: string;
}

type Fence = { start: number; bodyStart: number; marker: string; label: string };
type Block = Fence & { bodyEnd: number; end: number };

function findBlocks(answer: string) {
  const blocks: Block[] = [];
  let open: Fence | undefined;
  for (let start = 0; start < answer.length;) {
    const newline = answer.indexOf('\n', start);
    const end = newline === -1 ? answer.length : newline + 1;
    const line = answer.slice(start, newline === -1 ? end : newline).trimEnd();
    const match = /^[ \t]*(\x60{3,}|~{3,})(.*)$/.exec(line);
    const marker = match?.[1];
    const rest = match?.[2]?.trim() ?? '';
    if (marker) {
      if (!open) {
        open = { start, bodyStart: end, marker, label: rest.split(/\s+/, 1)[0]?.toLowerCase() ?? '' };
      } else if (!rest && marker[0] === open.marker[0] && marker.length >= open.marker.length) {
        if (open.label === 'investigation-conclusion' || open.label === 'json') {
          blocks.push({ ...open, bodyEnd: start, end });
        }
        open = undefined;
      }
    }
    start = end;
  }
  return blocks;
}

function parseBlock(answer: string, block: Block): InvestigationConclusion | undefined {
  try {
    const payload: unknown = JSON.parse(answer.slice(block.bodyStart, block.bodyEnd));
    const result = InvestigationConclusionSchema.safeParse(payload);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function extracted(answer: string, block: Block, conclusion: InvestigationConclusion): ExtractedInvestigationConclusion {
  const remaining = answer.slice(0, block.start) + answer.slice(block.end);
  const cleanedAnswer = remaining.replace(/(\r?\n)(?:[ \t]*\r?\n){2,}/g, '$1$1').trim();
  return { conclusion, cleanedAnswer: cleanedAnswer || conclusion.summary };
}

export function extractInvestigationConclusion(rawAnswer: string): ExtractedInvestigationConclusion {
  const blocks = findBlocks(rawAnswer).reverse();
  for (const block of blocks) {
    if (block.label !== 'investigation-conclusion') continue;
    const conclusion = parseBlock(rawAnswer, block);
    if (conclusion) return extracted(rawAnswer, block, conclusion);
  }
  const fallback = blocks.find(({ label }) => label === 'json');
  if (fallback) {
    const conclusion = parseBlock(rawAnswer, fallback);
    if (conclusion) return extracted(rawAnswer, fallback, conclusion);
  }
  return { conclusion: null, cleanedAnswer: rawAnswer };
}
