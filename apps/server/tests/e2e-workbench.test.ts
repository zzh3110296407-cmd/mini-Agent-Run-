import {
  ArtifactMetaSchema, FsBrowseResponseSchema, InvestigationRunSchema, MAX_INLINE_TOOL_OUTPUT_BYTES,
  RunEventEnvelopeSchema, SessionDetailSchema, SessionListItemSchema, SessionSchema, TextSliceResponseSchema,
  TraceOverviewSchema, type RunEventEnvelope,
} from '@mini-agent-run/shared';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  diagnosticPath, initialPrompt, largeLog, openOfflineWorkbench, slowPrompt,
} from '../../../scripts/cli/e2e-smoke.mjs';
import { openAppDatabase } from '../src/db/database.js';
import { createSqliteRunStore } from '../src/db/run-repository.js';
import { WORKSPACE_ROOT } from '../src/fs/path-sandbox.js';
import { startServer } from '../src/start-server.js';

const filePath = join(WORKSPACE_ROOT, diagnosticPath, largeLog);
const trainingDir = resolve(WORKSPACE_ROOT, '../Database/new data/TrajErrBench/train');
const fixtureNames = ['agent-run-failed.jsonl', 'agent-run-passed.jsonl', 'diagnostics.fixture.json', largeLog];
const tools = ['list_files', 'inspect_trace', 'read_file_slice', 'search_logs', 'read_artifact_slice', 'compare_files', 'check_runtime_diagnostics'];

function sessionUrl(id: string) { return '/api/sessions/' + id; }
function runUrl(id: string) { return '/api/runs/' + id; }
const runDetail = InvestigationRunSchema.pick({}).extend({
  run: InvestigationRunSchema, events: RunEventEnvelopeSchema.array(),
});
const artifactDetail = ArtifactMetaSchema.pick({}).extend({ artifact: ArtifactMetaSchema, slice: TextSliceResponseSchema });
const sessionList = SessionSchema.pick({}).extend({ sessions: SessionListItemSchema.array() });

describe('F12_E2E_VERIFICATION_SUITE real HTTP and disk SQLite', () => {
  it('E2E-01 through E2E-05 completes the offline investigation, interruption, recovery and deletion chain', async () => {
    const training = existsSync(trainingDir);
    const original = readFileSync(filePath);
    const lines = original.toString('utf8').split(/\r?\n/u);
    const workbench = await openOfflineWorkbench(WORKSPACE_ROOT, { extraRoots: training ? [trainingDir] : [], startServer });
    const { request, stream, end } = workbench;
    const create = async (targetPath: string) => SessionSchema.parse(await request('/api/sessions', 'POST', { targetPath }, 201));
    const start = async (sessionId: string, prompt: string) => InvestigationRunSchema.parse(
      await request(sessionUrl(sessionId) + '/runs', 'POST', { prompt }, 201),
    );
    const detail = async (id: string) => runDetail.parse(await request(runUrl(id)));
    try {
      const browse = FsBrowseResponseSchema.parse(await request('/api/fs/browse'));
      expect(browse.entries.map(({ name, kind }) => [name, kind])).toEqual(fixtureNames.map((name) => [name, 'file']));
      const blocked = '/api/fs/browse?' + new URLSearchParams({ path: workbench.directory });
      expect(await request(blocked, 'GET', undefined, 403)).toMatchObject({ error: { code: 'PATH_OUTSIDE_ALLOWED_ROOTS' } });
      const session = await create(diagnosticPath);
      const single = await create(join(diagnosticPath, 'agent-run-passed.jsonl'));
      expect([session.pathType, single.pathType]).toEqual(['dir', 'file']);
      const list = async () => sessionList.parse(await request('/api/sessions')).sessions.map(({ id }) => id);
      expect(await list()).toEqual([single.id, session.id]);
      expect(await request(sessionUrl(session.id), 'PATCH', { title: 'Investigate missing sequence' }))
        .toMatchObject({ id: session.id, title: 'Investigate missing sequence', titleSource: 'manual' });
      expect(await list()).toEqual([session.id, single.id]);

      if (training) {
        const file = readdirSync(trainingDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map(({ name }) => name).sort()[0];
        expect(file, 'Local training directory needs a JSON sample').toBeDefined();
        const trainingSession = await create(join(trainingDir, file!));
        const inspected = await start(trainingSession.id, 'Inspect the supplied training trace.');
        expect(await end(inspected.id)).toMatchObject({ status: 'completed' });
        const { events } = await detail(inspected.id);
        const result = events.find(({ event }) => event.type === 'tool_execution_end' && event.toolName === 'inspect_trace')?.event;
        expect(result).toMatchObject({ type: 'tool_execution_end', isError: false });
        if (result?.type !== 'tool_execution_end') throw new Error('Missing training inspection result');
        const toolMessage = workbench.provider.recordedRequests.at(-1)?.messages.find(
          (message: { role: string; name?: string }) => message.role === 'tool' && message.name === 'inspect_trace',
        );
        expect(toolMessage?.content).toBeTruthy();
        expect(TraceOverviewSchema.parse(JSON.parse(toolMessage.content)).format).toBe('trajerrbench_json');
        expect(JSON.stringify(events)).not.toMatch(/"annotation"\s*:/iu);
        expect(toolMessage.content).not.toMatch(/"annotation"\s*:/iu);
        await request(sessionUrl(trainingSession.id), 'DELETE');
      }

      const beforeInitial = workbench.provider.recordedRequests.length;
      const initial = await start(session.id, initialPrompt);
      const events: RunEventEnvelope[] = [];
      for await (const frame of stream(initial.id)) events.push(frame);
      expect(events.map(({ seq }) => seq)).toEqual(events.map((_, index) => index + 1));
      expect(events.some(({ event }) => event.type === 'message_update' && event.deltaType === 'text_delta')).toBe(true);
      const stage = events.filter(({ event }) => event.type === 'tool_execution_end').map(({ event }) => event);
      expect(stage).toMatchObject(['list_files', 'inspect_trace', 'search_logs', 'read_artifact_slice']
        .map((toolName) => ({ toolName, isError: false })));
      expect(workbench.provider.recordedRequests[beforeInitial].tools.map(({ name }: { name: string }) => name).sort())
        .toEqual([...tools].sort());
      const artifactId = stage[2]?.type === 'tool_execution_end' ? stage[2].artifactId : undefined;
      expect(artifactId).toMatch(/^art_/u);
      const final = events.at(-1)?.event;
      expect(final).toMatchObject({ type: 'agent_end', status: 'completed', conclusion: {
        threeStateAssessment: { terminationReason: 'stop', hasToolError: false, taskOutcome: 'failed' },
        evidence: [
          { kind: 'file_line', file: largeLog, startLine: 1100 },
          { kind: 'artifact_line', artifactId, startLine: 1 },
        ],
      } });
      const artifactPath = '/api/artifacts/' + artifactId;
      const stored = artifactDetail.parse(await request(artifactPath + '?limit=1'));
      expect(stored.artifact).toMatchObject({ id: artifactId, runId: initial.id, sourceTool: 'search_logs' });
      expect(stored.artifact.byteSize).toBeGreaterThan(MAX_INLINE_TOOL_OUTPUT_BYTES);
      const search = JSON.parse(stored.slice.lines[0]!.text);
      expect(search.matches).toHaveLength(60);
      for (const match of search.matches) expect(match.text).toBe(lines[match.lineNumber - 1]);
      const readRequest = workbench.provider.recordedRequests.at(-1)?.messages.find(
        (message: { role: string; name?: string }) => message.role === 'tool' && message.name === 'read_artifact_slice',
      );
      expect(readRequest?.content).toBeTruthy();
      const readback = JSON.parse(readRequest.content);
      expect(readback.lines[0].lineNumber).toBe(1);
      expect(stored.slice.lines[0]!.text.startsWith(readback.lines[0].text)).toBe(true);
      expect(readback.lines[0].text).toContain('matches');

      const rawSlice = async (filters: Record<string, string>) => TextSliceResponseSchema.parse(await request(
        sessionUrl(session.id) + '/file-slice?' + new URLSearchParams({ file: largeLog, ...filters }),
      ));
      const [error] = (await rawSlice({ level: 'error', q: 'missing the required sequence field' })).lines;
      expect(error).toEqual({ lineNumber: 1100, level: 'error', text: lines[1099] });
      for (const query of ['<script', '<img']) {
        const hits = (await rawSlice({ q: query })).lines;
        expect(hits.length).toBeGreaterThan(0);
        for (const hit of hits) expect(hit.text).toBe(lines[hit.lineNumber - 1]);
      }
      const followUp = await start(session.id, 'What should I verify next?');
      expect(await end(followUp.id)).toMatchObject({ status: 'completed' });
      const followUpTools = (await detail(followUp.id)).events
        .filter(({ event }) => event.type === 'tool_execution_end').map(({ event }) => event);
      expect(followUpTools).toMatchObject(['compare_files', 'read_file_slice'].map((toolName) => ({ toolName, isError: false })));
      expect(workbench.provider.recordedRequests.at(-1)?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: initialPrompt }),
        expect.objectContaining({ role: 'assistant', content: 'The first error identifies the missing sequence field.' }),
      ]));

      const slow = await start(session.id, slowPrompt);
      const prefix: RunEventEnvelope[] = [];
      for await (const frame of stream(slow.id)) {
        prefix.push(frame);
        if (frame.event.type === 'tool_execution_update') break;
      }
      expect(prefix.at(-1)?.event).toMatchObject({ type: 'tool_execution_update', toolName: 'check_runtime_diagnostics' });
      const resume: RunEventEnvelope[] = [];
      let stopStart: number | undefined;
      let stopElapsed: number | undefined;
      for await (const frame of stream(slow.id, prefix.at(-1)!.seq)) {
        resume.push(frame);
        if (stopStart === undefined && frame.event.type === 'tool_execution_update') {
          stopStart = performance.now();
          expect(await request(runUrl(slow.id) + '/stop', 'POST', {}, 202)).toEqual({ runId: slow.id, status: 'stopping' });
        }
        if (frame.event.type === 'agent_end' && stopStart !== undefined) stopElapsed = performance.now() - stopStart;
      }
      expect(stopElapsed).toBeDefined();
      expect(stopElapsed!).toBeLessThan(500);
      expect(resume[0]?.seq).toBe(prefix.at(-1)!.seq + 1);
      expect(resume.at(-1)?.event).toMatchObject({ type: 'agent_end', status: 'stopped', stopReason: 'user_abort' });
      const stopped = await detail(slow.id);
      expect(stopped.run).toMatchObject({ status: 'stopped', stopReason: 'user_abort' });
      expect(stopped.events).toEqual([...prefix, ...resume]);
      expect(stopped.events.map(({ seq }) => seq)).toEqual(stopped.events.map((_, index) => index + 1));
      for (const prompt of [undefined, 'Retry with a concise question.', 'Verify the retry chain.']) {
        // The unmodified retry runs the same slow diagnostic and is stopped as soon as it emits progress.
        const retry = InvestigationRunSchema.parse(await request(runUrl(slow.id) + '/retry', 'POST', prompt ? { prompt } : {}, 201));
        expect(retry).toMatchObject({ retryOfRunId: slow.id, prompt: prompt ?? slowPrompt });
        if (prompt) {
          expect(await end(retry.id)).toMatchObject({ status: 'completed' });
        } else {
          let sent = false;
          for await (const { event } of stream(retry.id)) {
            if (event.type === 'tool_execution_update' && !sent) {
              await request(runUrl(retry.id) + '/stop', 'POST', {}, 202);
              sent = true;
            }
            if (event.type === 'agent_end') expect(event).toMatchObject({ status: 'stopped', stopReason: 'user_abort' });
          }
          expect(sent).toBe(true);
        }
      }
      expect(await request(runUrl(slow.id) + '/retry', 'POST', {}, 409)).toMatchObject({ error: { code: 'RETRY_LIMIT_EXCEEDED' } });

      const durable = await detail(initial.id);
      expect(durable.events).toEqual(events);
      const history = SessionDetailSchema.parse(await request(sessionUrl(session.id)));
      await workbench.stop();
      const db = openAppDatabase(workbench.dbPath);
      let zombieId: string;
      try {
        const store = createSqliteRunStore(db);
        const stale = store.createRun({ sessionId: single.id, prompt: 'Simulate interrupted process ownership',
          modelId: 'mock', modelProvider: 'mock', toolMode: 'mock', maxSteps: 12 });
        zombieId = stale.id;
        expect(store.markRunning(stale.id, new Date().toISOString())).toBe(true);
        store.appendEvents(stale.id, [{ type: 'turn_start', step: 1 }]);
      } finally { db.close(); }
      await workbench.start();
      expect(await detail(initial.id)).toEqual(durable);
      expect(await detail(slow.id)).toEqual(stopped);
      expect(await request(sessionUrl(session.id))).toEqual(history);
      expect(await request(artifactPath + '?limit=1')).toEqual(stored);
      const recovered = await detail(zombieId);
      expect(recovered.run).toMatchObject({ status: 'failed', stopReason: 'server_restarted' });
      expect(recovered.events.map(({ seq, event }) => [seq, event.type])).toEqual([[1, 'turn_start'], [2, 'agent_end']]);

      await request(sessionUrl(session.id), 'DELETE');
      expect(await request(sessionUrl(single.id))).toMatchObject({ session: { id: single.id } });
      await request(sessionUrl(single.id), 'DELETE');
      expect(await request(artifactPath, 'GET', undefined, 404)).toMatchObject({ error: { code: 'ARTIFACT_NOT_FOUND' } });
      await workbench.stop();
      const cleared = openAppDatabase(workbench.dbPath);
      try {
        for (const table of ['sessions', 'investigation_runs', 'run_events', 'artifacts']) {
          expect(cleared.prepare<[], { count: number }>('SELECT count(*) AS count FROM ' + table).get()?.count).toBe(0);
        }
      } finally { cleared.close(); }
      expect(readFileSync(filePath).equals(original), 'Original fixture bytes changed').toBe(true);
    } finally {
      await workbench.close();
      expect(existsSync(workbench.directory)).toBe(false);
    }
  }, 10_000);
});
