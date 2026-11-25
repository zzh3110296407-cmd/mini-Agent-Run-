import type { ArtifactMeta, FsBrowseResponse, HealthResponse, InvestigationRun, Session, TextSliceResponse } from '@mini-agent-run/shared';

export const now = '2026-11-25T00:00:00.000Z';
export const health: HealthResponse = { status: 'ok', sqlite: 'ok', timestamp: now, service: 'mini-agent-run' };
export const session: Session = {
  id: 'ses_first', title: '排查会话 A', titleSource: 'manual', targetPath: '/safe/a', pathType: 'dir',
  createdAt: now, updatedAt: now,
};
export const browse: FsBrowseResponse = {
  currentPath: '/safe', parentPath: null, allowedRoots: ['/safe', '/other'],
  entries: [{ name: 'display-only', path: '/safe/real/sub_dir', kind: 'dir' }],
};
export const run: InvestigationRun = {
  id: 'run_fixture', sessionId: session.id, retryOfRunId: null, prompt: '定位问题', status: 'pending', stopReason: null,
  errorCode: null, errorMessage: null, modelProvider: 'mock', modelId: 'fixture', toolMode: 'mock', stepCount: 0,
  maxSteps: 12, finalAnswer: null, conclusion: null, lastSeq: 0, createdAt: now, startedAt: null, endedAt: null, durationMs: null,
};
export const slice: TextSliceResponse = {
  totalLines: 1, matchedLines: 1, offsetLine: 1, limit: 1, hasMore: false, nextOffsetLine: null,
  lines: [{ lineNumber: 1, level: 'info', text: 'INFO example' }],
};
export const artifact: ArtifactMeta = {
  id: 'art_fixture', runId: run.id, sessionId: session.id, toolCallId: 'tc_fixture', sourceTool: 'search_logs',
  title: '排查输出', contentType: 'text/plain', byteSize: 12, lineCount: 1, createdAt: now,
  summary: {
    byteSize: 12, lineCount: 1, truncatedForLlm: false, levelCounts: { error: 0, warn: 0, info: 1, other: 0 },
    firstErrorLine: null, previewHead: 'INFO example',
  },
};
