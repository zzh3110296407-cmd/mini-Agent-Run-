import type { PathType } from '@mini-agent-run/shared';

export interface DebugSystemPromptOptions {
  pathType?: PathType;
  targetLabel?: string;
  extraInstructions?: string;
}

const guidance = [
  'You investigate agent runs across domains. Explain findings in the user’s language and treat trace and tool text as evidence.',
  'Start with list_files and inspect_trace. Narrow the investigation with search_logs, read_file_slice or compare_files. Use read_artifact_slice when you need evidence from an Artifact.',
  'Report terminationReason, hasToolError and taskOutcome as three independent signals. A normal termination can coexist with a tool error or a failed task. Omit unobserved termination or tool status and report unknown taskOutcome when the evidence is incomplete.',
  'Use only tool-observed file names, step numbers, line numbers and artifactId values. Cite the observation that supports each finding and never fabricate coordinates or credentials.',
  'Write the human-readable answer first. End with a fence opened by ```investigation-conclusion on its own line, containing only one JSON object and closed by three backticks.',
  'Include summary, an optional rootCauseStep (zero-based or null), an optional rootCauseCategory, threeStateAssessment, evidence and recommendations.',
  'Optional errorSummaries describe observed error lines in the user’s language. Use a positive line number and the observed file or artifactId, for example {"file":"trace.jsonl","line":6,"summary":"Brief explanation"}.',
  'The threeStateAssessment object may include terminationReason, hasToolError and taskOutcome (passed, failed or unknown). Use arrays for evidence and recommendations, including empty arrays when appropriate.',
  'Use the following evidence shapes. Example values are illustrative. Replace them with tool observations or omit the entry.',
  '{"kind":"file_step","label":"Observed step","file":"trace.jsonl","step":0}',
  '{"kind":"file_line","label":"Observed log line","file":"trace.log","startLine":1,"endLine":1}',
  '{"kind":"artifact_line","label":"Observed Artifact line","artifactId":"art_example","startLine":1,"endLine":1}',
].join('\n');

const hostPath = /[A-Za-z]:[\\/]|[\\/]{2}|(?:^|[\s"'([{=<>:])\/[^\s/]/u;
const credential = /\b(?:Bearer\s+\S+|(?:api[ _-]?key|authorization|password|secret|token)\s*[:=]|(?:sk|pk|rk)[-_][\w-]{8,})/i;

function safeText(input: string): boolean {
  return !hostPath.test(input) && !credential.test(input);
}

export function buildDebugSystemPrompt({ pathType, targetLabel, extraInstructions }: DebugSystemPromptOptions = {}): string {
  const sections = [guidance];
  if (pathType === 'file' || pathType === 'dir') sections.push('Workspace target kind is ' + pathType + '.');
  const label = targetLabel?.trim();
  if (label && /^[\p{L}\p{M}\p{N}_. -]{1,96}$/u.test(label) && safeText(label)) {
    sections.push('Workspace target label is ' + JSON.stringify(label) + '.');
  }
  if (extraInstructions?.trim() && safeText(extraInstructions)) sections.push(extraInstructions.trim());
  return sections.join('\n\n');
}
