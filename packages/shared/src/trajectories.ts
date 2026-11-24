import { z } from 'zod';

export const MAX_TRAJECTORY_RUN_ID_LENGTH = 512;

const runId = z.string().min(1).max(MAX_TRAJECTORY_RUN_ID_LENGTH);
const nonnegativeInteger = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().nonnegative());

export const ListTrajectoryRunsSchema = z.object({
  limit: nonnegativeInteger.pipe(z.number().min(1).max(100)).default(30),
});

export const GetTrajectoryRunSchema = z.object({
  runId,
  after: nonnegativeInteger.optional(),
  limit: nonnegativeInteger.pipe(z.number().min(1).max(100)).default(50),
});

export const SearchTrajectoryLogsSchema = z.object({
  query: z.string().trim().min(1).max(160),
  runId: runId.optional(),
  limit: nonnegativeInteger.pipe(z.number().min(1).max(20)).default(10),
});

export const ReadTrajectoryLogSchema = z.object({
  runId,
  step: nonnegativeInteger,
  offset: nonnegativeInteger.default(0),
});

export interface TrajectorySummary {
  runId: string;
  sourceBenchmark: string;
  taskDescription: string;
  reward: number;
  stepCount: number;
  logBytes: number;
}

export interface TrajectoryStep {
  step: number;
  role: string;
  name: string;
  contentLength: number;
}

export interface TrajectoryRunPage {
  run: TrajectorySummary;
  steps: TrajectoryStep[];
  nextAfter: number | null;
}

export interface TrajectoryLogHit {
  runId: string;
  step: number;
  role: string;
  name: string;
  excerpt: string;
}

export interface TrajectoryLogChunk extends TrajectoryStep {
  runId: string;
  offset: number;
  text: string;
  nextOffset: number | null;
}

export interface TrajectoryTools {
  listRuns(input: unknown): TrajectorySummary[];
  getRunDetail(input: unknown): TrajectoryRunPage | null;
  searchRuntimeLogs(input: unknown): TrajectoryLogHit[];
  readRuntimeLog(input: unknown): TrajectoryLogChunk | null;
}
