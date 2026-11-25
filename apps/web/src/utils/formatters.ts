import type { RunStatus, StopReason, TaskOutcome } from '@mini-agent-run/shared';

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index++;
  }
  return Number(amount.toFixed(1)) + ' ' + units[index];
}

export function formatDurationMs(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's';
}

export function formatRelativeTime(iso: string, now = Date.now()) {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return '—';
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return minutes + ' 分钟前';
  if (minutes < 1440) return Math.floor(minutes / 60) + ' 小时前';
  return Math.floor(minutes / 1440) + ' 天前';
}

const statusLabels: Record<RunStatus, string> = {
  pending: '等待中', running: '排查中', completed: '已完成', stopped: '已停止', failed: '执行失败',
};
const stopLabels: Record<StopReason, string> = {
  completed: '已完成', user_abort: '人工停止', max_steps: '达到步数上限', error: '执行异常', server_restarted: '服务重启中止',
};
const outcomeLabels: Record<TaskOutcome, string> = { passed: '通过', failed: '失败', unknown: '未知' };

export const formatRunStatus = (status: RunStatus) => statusLabels[status];
export const formatStopReason = (reason: StopReason | null) => reason === null ? '—' : stopLabels[reason];
export const formatTaskOutcome = (outcome: TaskOutcome) => outcomeLabels[outcome];
