import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from '../src/api/client';
import { artifact, browse, health, now, run, session, slice } from './fixtures';

function fixtureClient(getApiKey?: () => string | undefined) {
  const fetchImpl = vi.fn<typeof fetch>();
  const client = createApiClient({ fetchImpl, getApiKey });
  return { client, fetchImpl };
}

describe('M3.1 API Client', () => {
  it('W1-02 解析浏览、会话、文件切片和 Artifact，并对查询项和路径段编码', async () => {
    const { client, fetchImpl } = fixtureClient();
    fetchImpl.mockResolvedValueOnce(Response.json(health))
      .mockResolvedValueOnce(Response.json(browse))
      .mockResolvedValueOnce(Response.json({ sessions: [{ ...session, hasActiveRun: false, runCount: 0 }] }))
      .mockResolvedValueOnce(Response.json(session, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ session, hasActiveRun: false, runs: [] }))
      .mockResolvedValueOnce(Response.json({ ...session, title: '新标题' }))
      .mockResolvedValueOnce(Response.json(slice))
      .mockResolvedValueOnce(Response.json({ artifact, slice }))
      .mockResolvedValueOnce(Response.json({ id: session.id, deleted: true }));

    expect(await client.getHealth()).toEqual(health);
    const path = 'D:\\safe\\a b#?中文';
    expect(await client.browseFs(path)).toEqual(browse);
    expect(await client.listSessions()).toEqual({ sessions: [{ ...session, hasActiveRun: false, runCount: 0 }] });
    expect(await client.createSession({ targetPath: path })).toEqual(session);
    expect((await client.getSessionDetail('ses_?/#')).session).toEqual(session);
    expect((await client.renameSession(session.id, { title: '新标题' })).title).toBe('新标题');
    expect(await client.getSessionFileSlice(session.id, { startLine: 2, limit: 1, file: path, level: 'info', q: 'a&b' })).toEqual(slice);
    expect(await client.getArtifactSlice(artifact.id, { offsetLine: 17, limit: 3, level: 'error' })).toEqual({ artifact, slice });
    expect(await client.deleteSession(session.id)).toEqual({ id: session.id, deleted: true });

    const calls = fetchImpl.mock.calls;
    expect(calls[0]?.[0]).toBe('/api/health');
    expect(calls[1]?.[0]).toBe('/api/fs/browse?' + new URLSearchParams({ path }).toString());
    expect(calls[3]).toEqual(['/api/sessions', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ targetPath: path }),
    })]);
    expect(calls[4]?.[0]).toBe('/api/sessions/ses_%3F%2F%23');
    expect(calls[5]).toEqual(['/api/sessions/ses_first', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ title: '新标题' }),
    })]);
    expect(calls[6]?.[0]).toBe('/api/sessions/ses_first/file-slice?' + new URLSearchParams({
      startLine: '2', limit: '1', file: path, level: 'info', q: 'a&b',
    }).toString());
    expect(calls[7]?.[0]).toBe('/api/artifacts/art_fixture?offsetLine=17&limit=3&level=error');
    expect(calls[8]?.[1]?.method).toBe('DELETE');
  });

  it('W1-02 校验运行详情、停止联合状态和 SSE 游标 URL', async () => {
    const { client, fetchImpl } = fixtureClient(() => 'local-override-key-001');
    const events = [{ seq: 1, runId: run.id, timestamp: now, event: { type: 'turn_start', step: 1 } }];
    fetchImpl.mockResolvedValueOnce(Response.json({ run, events }))
      .mockResolvedValueOnce(Response.json({ runId: run.id, status: 'stopping' }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ runId: run.id, status: 'stopped', alreadyTerminal: true }))
      .mockResolvedValueOnce(Response.json({ runId: run.id, status: 'running', alreadyTerminal: true }))
      .mockResolvedValueOnce(Response.json({ run, events: [{ ...events[0], event: { type: 'turn_start' } }] }));

    expect(await client.getRunDetail(run.id)).toEqual({ run, events });
    expect(await client.stopRun(run.id)).toEqual({ runId: run.id, status: 'stopping' });
    expect(await client.stopRun(run.id)).toEqual({ runId: run.id, status: 'stopped', alreadyTerminal: true });
    await expect(client.stopRun(run.id)).rejects.toMatchObject({ name: 'ZodError' });
    await expect(client.getRunDetail(run.id)).rejects.toMatchObject({ name: 'ZodError' });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/runs/run_fixture/stop');
    expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).has('X-LLM-API-Key')).toBe(false);
    expect(client.buildRunStreamUrl('run_a/?', 0)).toBe('/api/runs/run_a%2F%3F/stream?afterSeq=0');
    expect(client.buildRunStreamUrl(run.id)).toBe('/api/runs/run_fixture/stream');
  });

  it('U1-03 编码文件定位查询并校验可选选中文件', async () => {
    const { client, fetchImpl } = fixtureClient();
    const path = 'D:\\轨迹目录\\a b?#.jsonl';
    const selected = { ...browse, selectedFile: path };
    fetchImpl.mockResolvedValueOnce(Response.json(selected))
      .mockResolvedValueOnce(Response.json({ ...browse, selectedFile: ' \t ' }));
    expect(await client.browseFs(path, { resolveFile: true })).toEqual(selected);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/fs/browse?' + new URLSearchParams({ path, resolveFile: '1' }));
    await expect(client.browseFs(path, { resolveFile: true })).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('W1-02 保留后端结构化错误并区分无效响应和网络故障', async () => {
    const { client, fetchImpl } = fixtureClient();
    for (const [status, code] of [[403, 'PATH_OUTSIDE_ALLOWED_ROOTS'], [404, 'PATH_NOT_FOUND'],
      [409, 'SESSION_HAS_ACTIVE_RUN'], [503, 'NO_ACCESSIBLE_ROOTS']] as const) {
      const message = '  精确错误消息 ' + status + '  ';
      fetchImpl.mockResolvedValueOnce(Response.json({ error: { code, message } }, { status }));
      await expect(client.browseFs()).rejects.toMatchObject({ name: 'ApiError', status, code, message });
    }
    fetchImpl.mockResolvedValueOnce(Response.json({ status: 'unavailable', sqlite: 'error' }, { status: 503 }))
      .mockResolvedValueOnce(new Response('<html>', { status: 502 }))
      .mockResolvedValueOnce(new Response('<html>'))
      .mockResolvedValueOnce(Response.json({ sessions: [{ ...session, targetPath: undefined }] }))
      .mockRejectedValueOnce(new TypeError('offline'));
    await expect(client.getHealth()).rejects.toMatchObject({ status: 503, code: 'HEALTH_UNAVAILABLE' });
    await expect(client.listSessions()).rejects.toMatchObject({ status: 502, code: 'HTTP_ERROR' });
    await expect(client.listSessions()).rejects.toMatchObject({ status: 200, code: 'INVALID_RESPONSE' });
    await expect(client.listSessions()).rejects.toMatchObject({ name: 'ZodError' });
    await expect(client.getHealth()).rejects.toBeInstanceOf(ApiError);
  });

  it('W1-03 仅开始和重跑读取最新的覆盖 Key，并清理上游错误消息', async () => {
    const localKey = 'local-override-key-001';
    let override: string | undefined;
    const { client, fetchImpl } = fixtureClient(() => override);
    for (let call = 0; call < 5; call++) fetchImpl.mockResolvedValueOnce(Response.json(run, { status: 201 }));
    await client.startRun(session.id, { prompt: '排查' });
    await client.retryRun(run.id);
    override = '  ' + localKey + '  ';
    await client.startRun(session.id, { prompt: '排查', maxSteps: 3 });
    await client.retryRun(run.id, { prompt: '复查' });
    override = '  ';
    await client.startRun(session.id, { prompt: '排查' });

    const calls = fetchImpl.mock.calls;
    expect(calls.map(([, init]) => new Headers(init?.headers).get('X-LLM-API-Key')))
      .toEqual([null, null, localKey, localKey, null]);
    expect(calls.map(([url]) => url)).toEqual([
      '/api/sessions/ses_first/runs', '/api/runs/run_fixture/retry',
      '/api/sessions/ses_first/runs', '/api/runs/run_fixture/retry', '/api/sessions/ses_first/runs',
    ]);
    expect(calls[2]?.[1]?.body).toBe(JSON.stringify({ prompt: '排查', maxSteps: 3 }));
    override = localKey;
    fetchImpl.mockResolvedValueOnce(Response.json({ error: { code: 'BAD_' + localKey, message: '值为 ' + localKey } }, { status: 502 }));
    await expect(client.retryRun(run.id)).rejects.toMatchObject({ code: 'BAD_[已隐藏]', message: '值为 [已隐藏]' });
    expect(client.buildRunStreamUrl(run.id, 5)).toBe('/api/runs/run_fixture/stream?afterSeq=5');
  });
});
