import type { EvidenceRef, SessionId } from '@mini-agent-run/shared';
import type { InspectorTargetRequest } from '../composables/useRunStream';
import type { JumpTarget, ToolCallViewItem } from './runTimelineReducer';

export function evidenceInspectorTarget(sessionId: SessionId, evidence: EvidenceRef): InspectorTargetRequest {
  const { label } = evidence;
  if (evidence.kind === 'artifact_line') {
    return { mode: 'artifact', artifactId: evidence.artifactId, line: evidence.startLine, endLine: evidence.endLine, label };
  }
  const { file } = evidence;
  return evidence.kind === 'file_step'
    ? { mode: 'file', sessionId, file, step: evidence.step, label }
    : { mode: 'file', sessionId, file, line: evidence.startLine, endLine: evidence.endLine, label };
}

export function toolInspectorTarget(
  sessionId: SessionId, tool: Pick<ToolCallViewItem, 'artifactId' | 'fileTarget'> & Pick<JumpTarget, 'line'>, label: string,
): InspectorTargetRequest | undefined {
  if (tool.artifactId !== undefined) return { mode: 'artifact', artifactId: tool.artifactId, line: tool.line, label };
  if (tool.fileTarget) return { mode: 'file', sessionId, ...tool.fileTarget, line: tool.line ?? tool.fileTarget.line, label };
}
