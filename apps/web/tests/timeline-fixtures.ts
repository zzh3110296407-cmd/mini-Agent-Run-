import type { AgentEvent, InvestigationConclusion, InvestigationRun, RunEventEnvelope } from '@mini-agent-run/shared';
import { now, run } from './fixtures';

export const closedRun: InvestigationRun = {
  ...run, status: 'completed', stopReason: 'completed', startedAt: now, endedAt: now, durationMs: 200,
};

export const conclusion: InvestigationConclusion = {
  summary: '工具返回了失败信号。',
  threeStateAssessment: { terminationReason: 'user_stop', hasToolError: false, taskOutcome: 'failed' },
  evidence: [
    { kind: 'file_line', file: 'trace.log', startLine: 8, endLine: 10, label: '原始日志' },
    { kind: 'artifact_line', artifactId: 'art_fixture', startLine: 15, label: '工具日志' },
    { kind: 'file_step', file: 'trace.log', step: 0, label: '起始步骤' },
  ],
  recommendations: ['核对请求参数。', '重放失败步骤。'],
};

export function frame(seq: number, event: AgentEvent, runId = run.id): RunEventEnvelope {
  return { seq, runId, timestamp: now, event };
}
