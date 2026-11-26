import { COMPUTER_ROOT_PATH, FsBrowseResponseSchema } from '@mini-agent-run/shared';
import fc from 'fast-check';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  PathSandboxError, WORKSPACE_ROOT, resolveAllowedRoots, resolveSafeTracePath,
} from '../src/fs/path-sandbox.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

const route = '/api/fs/browse';
const browseUrl = (path: string) => route + '?path=' + encodeURIComponent(path);
const outsideError = { statusCode: 403, code: 'PATH_OUTSIDE_ALLOWED_ROOTS' };

function makeDirectoryLink(target: string, link: string) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('[F01_SAFE_PATH_BROWSE] safe trace paths and directory browsing', () => {
  let fixture: string;
  let root: string;
  let second: string;
  let outside: string;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    const fixtureParent = fs.realpathSync.native(tmpdir());
    fixture = fs.mkdtempSync(join(fixtureParent, 'm12-fs-'));
    if (dirname(fixture) !== fixtureParent) throw new Error('Unexpected sandbox fixture directory.');
    root = join(fixture, 'root');
    second = join(fixture, 'second root');
    outside = join(fixture, 'root-evil');
    for (const path of [root, second, outside]) fs.mkdirSync(path);
    app = buildApp({ allowedTraceRoots: ['missing', 'root', './root', root, second], baseDir: fixture });
  });

  afterEach(async () => {
    vi.mocked(fs.readdirSync).mockReset();
    try {
      await app.close();
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  async function readBrowse(path?: string) {
    const response = await app.inject(path === undefined ? route : browseUrl(path));
    expect(response.statusCode, response.body).toBe(200);
    return FsBrowseResponseSchema.parse(response.json());
  }

  async function expectError(url: string, statusCode: number, code: string) {
    const response = await app.inject(url);
    expect(response.statusCode, response.body).toBe(statusCode);
    const body = response.json();
    expect(body).toEqual({ error: { code, message: expect.any(String) } });
    expect(body.error.message).not.toContain(fixture);
    expect(body.error.message).not.toContain('private diagnostic');
  }

  it('anchors defaults at the workspace and ignores process configuration in zero-argument health', async () => {
    expect(JSON.parse(fs.readFileSync(join(WORKSPACE_ROOT, 'package.json'), 'utf8')).name)
      .toBe('mini-agent-run-workspace');
    const oldPort = process.env.PORT;
    process.env.PORT = 'invalid';
    const defaults = buildApp();
    try {
      expect((await defaults.inject('/api/health')).statusCode).toBe(200);
      const response = await defaults.inject(route);
      expect(response.statusCode).toBe(200);
      const data = FsBrowseResponseSchema.parse(response.json());
      expect(data.currentPath).toBe(fs.realpathSync.native(join(WORKSPACE_ROOT, 'data', 'fixtures')));
      expect(data.parentPath).toBe(dirname(data.currentPath));
      expect(data.entries.map(({ name }) => name)).not.toContain('.gitkeep');
      const parent = await defaults.inject(browseUrl(data.parentPath!));
      expect(parent.statusCode, parent.body).toBe(200);
      expect(parent.json().currentPath).toBe(data.parentPath);
      const drive = parse(data.currentPath).root;
      const top = await defaults.inject(browseUrl(drive));
      expect(top.statusCode, top.body).toBe(200);
      expect(top.json().currentPath).toBe(drive);
      expect(top.json().parentPath).toBe(data.allowedRoots.length > 1 ? COMPUTER_ROOT_PATH : null);
      if (process.platform !== 'win32' || data.allowedRoots.length > 1) {
        const computer = await defaults.inject(browseUrl(COMPUTER_ROOT_PATH));
        expect(computer.statusCode, computer.body).toBe(200);
        if (process.platform === 'win32') {
          expect(computer.json()).toEqual({ currentPath: COMPUTER_ROOT_PATH, parentPath: null,
            allowedRoots: data.allowedRoots, entries: data.allowedRoots.map((path) => ({ name: path, path, kind: 'dir' })) });
        } else {
          expect(computer.json()).toMatchObject({ currentPath: '/', parentPath: null, allowedRoots: ['/'] });
        }
      }
      for (const name of ['.env', '.env.local', '.ssh', '.aws', '.gnupg', '.git', '.npmrc', 'node_modules']) {
        const denied = await defaults.inject(browseUrl(name));
        expect(denied.statusCode).toBe(403);
        expect(denied.json().error.code).toBe('PATH_FORBIDDEN');
      }
      for (const path of ['../Database/offline-eval', '../../Database/offline-eval', '.env']) {
        expect((await defaults.inject(browseUrl(path))).statusCode).toBe(403);
      }
    } finally {
      if (oldPort === undefined) delete process.env.PORT;
      else process.env.PORT = oldPort;
      await defaults.close();
    }
  });

  it('opens the first usable root, deduplicates real roots, and switches between them', async () => {
    const alias = join(fixture, 'alias');
    makeDirectoryLink(root, alias);
    fs.writeFileSync(join(fixture, 'not-a-directory.txt'), '');
    expect(resolveAllowedRoots(['missing', 'not-a-directory.txt', alias, root, second], fixture))
      .toEqual([root, second]);
    expect(await readBrowse()).toEqual({
      currentPath: root, parentPath: null, allowedRoots: [root, second], entries: [],
    });
    expect(await readBrowse(second)).toMatchObject({ currentPath: second, parentPath: null });
    expect(await readBrowse('second root')).toMatchObject({ currentPath: second, parentPath: null });
  });

  it('filters and sorts entries and navigates using the returned real path', async () => {
    for (const name of ['a-dir', ' Z with spaces', '.hidden', 'Node_Modules']) fs.mkdirSync(join(root, name));
    for (const name of ['z.log', 'm.jsonl', 'a.txt', 'A.JSON', 'ignore.md', 'ignore.exe', 'ignore.ts',
      '.gitkeep', '.env', '.env.local', '.npmrc']) fs.writeFileSync(join(root, name), 'fixture');

    const data = await readBrowse();
    expect(data.entries.map(({ name, kind }) => [name, kind])).toEqual([
      ['Z with spaces', 'dir'], ['a-dir', 'dir'], ['A.JSON', 'file'],
      ['a.txt', 'file'], ['m.jsonl', 'file'], ['z.log', 'file'],
    ]);
    const [directory] = data.entries;
    expect(directory?.path).toBe(join(root, ' Z with spaces'));
    expect(await readBrowse(directory?.path)).toMatchObject({ currentPath: directory?.path, parentPath: root });
    expect(data.entries.find(({ name }) => name === 'A.JSON')?.byteSize).toBe(7);
  });

  it('keeps a nested configured root as the navigation boundary', () => {
    const nested = join(root, 'nested');
    fs.mkdirSync(nested);
    expect(resolveSafeTracePath(nested, [root, nested])).toEqual({ realPath: nested, rootPath: nested, kind: 'dir' });
    const volume = parse(root).root;
    expect(resolveSafeTracePath(nested, [volume]).rootPath).toBe(volume);
  });

  it('denies sibling prefix collisions and existing or missing outside paths', async () => {
    const traversal = relative(root, outside);
    for (const path of [outside, join(outside, 'missing'), '../missing', 'root/' + traversal]) {
      await expectError(browseUrl(path), 403, 'PATH_OUTSIDE_ALLOWED_ROOTS');
    }
    if (process.platform === 'win32') {
      expect((await readBrowse(root.toUpperCase())).currentPath).toBe(root);
      await expectError(browseUrl(outside.toUpperCase()), 403, 'PATH_OUTSIDE_ALLOWED_ROOTS');
      const drive = parse(root).root[0]?.toUpperCase() === 'Z' ? 'Y' : 'Z';
      await expectError(browseUrl(drive + ':\\m12-outside'), 403, 'PATH_OUTSIDE_ALLOWED_ROOTS');
    }
  });

  it('filters escaping and dangling junctions and rejects navigation via the escaping junction', async () => {
    const escaping = join(root, 'escape');
    makeDirectoryLink(outside, escaping);
    const missingTarget = join(outside, 'removed-target');
    fs.mkdirSync(missingTarget);
    makeDirectoryLink(missingTarget, join(root, 'dangling'));
    fs.rmdirSync(missingTarget);
    expect((await readBrowse()).entries).toEqual([]);
    for (const path of [escaping, join(escaping, 'missing.json'), join(root, 'dangling')]) {
      await expectError(browseUrl(path), 403, 'PATH_OUTSIDE_ALLOWED_ROOTS');
    }
  });

  it('rejects sensitive original, lexical and physical path segments', async () => {
    for (const name of ['.env', '.ENV.local', '.npmrc']) fs.writeFileSync(join(root, name), 'fixture');
    const safe = join(root, 'safe');
    const modules = join(root, 'node_modules');
    fs.mkdirSync(safe);
    fs.mkdirSync(modules);
    makeDirectoryLink(safe, join(root, '.git'));
    makeDirectoryLink(modules, join(root, 'ordinary-name'));
    const paths = ['.env', '.ENV.local', '.npmrc', '.git', 'node_modules', 'ordinary-name']
      .map((name) => join(root, name));
    paths.push(root + '/.git/../safe');
    for (const path of paths) await expectError(browseUrl(path), 403, 'PATH_FORBIDDEN');
    expect((await readBrowse()).entries.map(({ name }) => name)).toEqual(['safe']);
  });

  it('protects offline evaluation data and aliases in default and configured roots', async () => {
    const database = join(root, 'Database');
    const evaluation = join(database, 'offline-eval');
    const answer = join(evaluation, 'test.jsonl');
    const alias = join(root, 'alias');
    fs.mkdirSync(evaluation, { recursive: true });
    fs.writeFileSync(answer, '{}');
    makeDirectoryLink(evaluation, alias);
    await expectError(browseUrl(evaluation), 403, 'PATH_FORBIDDEN');
    await expectError(browseUrl(alias), 403, 'PATH_FORBIDDEN');
    expect((await readBrowse(database)).entries).toEqual([]);

    const defaults = buildApp({ baseDir: fixture });
    try {
      for (const url of [browseUrl(evaluation), browseUrl(alias), browseUrl(answer) + '&resolveFile=1']) {
        const response = await defaults.inject(url);
        expect(response.statusCode).toBe(403);
        expect(response.json().error.code).toBe('PATH_FORBIDDEN');
      }
      const session = await defaults.inject({ method: 'POST', url: '/api/sessions', payload: { targetPath: evaluation } });
      expect(session.statusCode).toBe(403);
      expect(session.json().error.code).toBe('PATH_FORBIDDEN');
    } finally {
      await defaults.close();
    }
  });

  it.each(['default', 'allowlist'])('opens only the evaluation test traces in %s mode', async (mode) => {
    const dataset = join(root, 'Database', 'offline-eval', 'TrajErrBench');
    const testDir = join(dataset, 'test');
    const answers = join(dataset, 'answers');
    const otherTest = join(dataset, 'testing');
    for (const directory of [testDir, answers, otherTest]) fs.mkdirSync(directory, { recursive: true });
    const trace = join(testDir, 'worker.jsonl');
    fs.writeFileSync(trace, '{"step":1}');
    fs.writeFileSync(join(answers, 'worker.jsonl'), '{"ground_truth":"protected"}');
    const link = join(testDir, 'answer-link');
    makeDirectoryLink(answers, link);
    const server = mode === 'default' ? buildApp({ baseDir: fixture }) : app;
    try {
      const picked = await server.inject(browseUrl(trace) + '&resolveFile=1');
      expect(picked.statusCode).toBe(200);
      const browse = FsBrowseResponseSchema.parse(picked.json());
      expect(browse).toMatchObject({ selectedFile: trace, currentPath: testDir });
      expect(browse.entries.map(({ name }) => name)).toEqual(['worker.jsonl']);
      expect((await server.inject(browseUrl(testDir))).statusCode).toBe(200);
      for (const path of [dataset, answers, otherTest, join(link, 'worker.jsonl'), testDir + '/../answers/worker.jsonl']) {
        const denied = await server.inject(browseUrl(path) + '&resolveFile=1');
        expect(denied.statusCode).toBe(403);
        expect(denied.json().error.code).toBe('PATH_FORBIDDEN');
      }
      const deniedSession = await server.inject({ method: 'POST', url: '/api/sessions', payload: { targetPath: answers } });
      expect(deniedSession.statusCode).toBe(403);
      const session = await server.inject({ method: 'POST', url: '/api/sessions', payload: { targetPath: trace } });
      expect(session.statusCode).toBe(201);
      expect(session.json()).toMatchObject({ pathType: 'file', targetPath: trace });
      const body = await server.inject('/api/sessions/' + session.json().id + '/file-slice');
      expect(body.statusCode).toBe(200);
      expect(body.json().lines).toEqual([{ lineNumber: 1, level: 'other', text: '{"step":1}' }]);
    } finally {
      if (mode === 'default') await server.close();
    }
  });

  it('validates safe files and distinguishes missing paths from non-directories', async () => {
    const file = join(root, 'valid.json');
    fs.writeFileSync(file, '{}');
    expect(resolveSafeTracePath(file, [root])).toEqual({ realPath: file, rootPath: root, kind: 'file' });
    await expectError(browseUrl(file), 400, 'PATH_NOT_A_DIRECTORY');
    await expectError(browseUrl(join(file, 'child')), 400, 'PATH_NOT_A_DIRECTORY');
    await expectError(browseUrl(join(root, 'missing-sub')), 404, 'PATH_NOT_FOUND');
  });

  it('canonically resolves supported files only when requested and retains directory containment', async () => {
    const file = join(root, 'valid-中.jsonl');
    fs.writeFileSync(file, '{}');
    fs.writeFileSync(join(root, 'unsupported.exe'), '');
    fs.writeFileSync(join(root, 'notes.md'), '');
    fs.writeFileSync(join(root, '.env'), '');
    fs.mkdirSync(join(root, '.ssh'));
    fs.writeFileSync(join(root, '.ssh', 'sample.log'), '');
    fs.writeFileSync(join(outside, 'private.log'), '');
    const fileUrl = (path: string) => browseUrl(path) + '&resolveFile=1';
    const directory = await readBrowse(root);
    for (const flag of ['1', 'true']) {
      const response = await app.inject(browseUrl(file) + '&resolveFile=' + flag);
      expect(response.statusCode, response.body).toBe(200);
      expect(FsBrowseResponseSchema.parse(response.json())).toEqual({ ...directory, selectedFile: file });
    }
    for (const suffix of ['', '&resolveFile=0', '&resolveFile=false']) {
      await expectError(browseUrl(file) + suffix, 400, 'PATH_NOT_A_DIRECTORY');
    }
    await expectError(fileUrl(join(root, 'unsupported.exe')), 400, 'UNSUPPORTED_TRACE_FILE');
    await expectError(fileUrl(join(root, 'notes.md')), 400, 'UNSUPPORTED_TRACE_FILE');
    await expectError(fileUrl(join(root, '.env')), 403, 'PATH_FORBIDDEN');
    await expectError(fileUrl(join(root, '.ssh', 'sample.log')), 403, 'PATH_FORBIDDEN');
    await expectError(fileUrl(join(outside, 'private.log')), 403, 'PATH_OUTSIDE_ALLOWED_ROOTS');
    await expectError(fileUrl(join(root, 'missing.log')), 404, 'PATH_NOT_FOUND');
    await expectError(browseUrl(COMPUTER_ROOT_PATH), 400, 'INVALID_PATH');
    await expectError(browseUrl(file) + '&resolveFile=yes', 400, 'INVALID_PATH');
    await expectError(browseUrl(file) + '&resolveFile=1&resolveFile=0', 400, 'INVALID_PATH');
  });

  it.each(['default', 'allowlist'])('lists only the explicitly selected hidden trace in %s mode', async (mode) => {
    const names = ['visible.log', '.trace.log', '.other.log', '.env.trace.log', '.notes.md'];
    for (const name of names) fs.writeFileSync(join(root, name), 'fixture');
    const server = mode === 'default' ? buildApp({ baseDir: fixture }) : app;
    const locate = (name: string) => browseUrl(join(root, name)) + '&resolveFile=1';
    try {
      const ordinary = await server.inject(browseUrl(root));
      expect(ordinary.statusCode, ordinary.body).toBe(200);
      expect(FsBrowseResponseSchema.parse(ordinary.json()).entries.map(({ name }) => name)).toEqual(['visible.log']);

      const response = await server.inject(locate('.trace.log'));
      expect(response.statusCode, response.body).toBe(200);
      const selected = FsBrowseResponseSchema.parse(response.json());
      const file = fs.realpathSync.native(join(root, '.trace.log'));
      expect(selected).toMatchObject({ currentPath: root, selectedFile: file });
      expect(selected.entries.map(({ name }) => name)).toEqual(['.trace.log', 'visible.log']);
      expect(selected.entries.filter(({ path }) => path === selected.selectedFile))
        .toEqual([{ name: '.trace.log', path: file, kind: 'file', byteSize: 7, modifiedAt: expect.any(String) }]);

      const forbidden = await server.inject(locate('.env.trace.log'));
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json().error.code).toBe('PATH_FORBIDDEN');
      const invalid = await server.inject(locate('.notes.md'));
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe('UNSUPPORTED_TRACE_FILE');
    } finally {
      if (mode === 'default') await server.close();
    }
  });

  it('starts at a custom base directory when its fixture folder is unavailable', async () => {
    const defaults = buildApp({ baseDir: fixture });
    try {
      const response = await defaults.inject(route);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ currentPath: fixture, parentPath: dirname(fixture) });
      const file = join(root, 'selected.txt');
      fs.writeFileSync(file, 'trace');
      const selected = await defaults.inject(browseUrl(file) + '&resolveFile=1');
      expect(selected.statusCode, selected.body).toBe(200);
      expect(selected.json()).toMatchObject({ currentPath: root, parentPath: fixture, selectedFile: file });
    } finally {
      await defaults.close();
    }
  });

  it.each([
    { case: 'empty', path: '' },
    { case: 'whitespace', path: '   ' },
    { case: 'NUL', path: 'bad\0path' },
    { case: 'overlong', path: 'x'.repeat(4097) },
  ])('rejects an invalid query path ($case)', async ({ path }) => {
    await expectError(browseUrl(path), 400, 'INVALID_PATH');
  });

  it('rejects a repeated path and reports 503 when no root is accessible', async () => {
    await expectError(route + '?path=a&path=b', 400, 'INVALID_PATH');
    const unavailable = buildApp({ allowedTraceRoots: [join(fixture, 'missing')] });
    try {
      const response = await unavailable.inject(route);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: { code: 'NO_ACCESSIBLE_ROOTS', message: expect.any(String) },
      });
      expect((await unavailable.inject('/api/health')).statusCode).toBe(200);
    } finally {
      await unavailable.close();
    }
  });

  it.each([
    ['ENOENT', 404, 'PATH_NOT_FOUND'],
    ['ENOTDIR', 400, 'PATH_NOT_A_DIRECTORY'],
    ['EACCES', 403, 'PATH_FORBIDDEN'],
    ['EPERM', 403, 'PATH_FORBIDDEN'],
    ['EINVAL', 400, 'INVALID_PATH'],
    ['ENAMETOOLONG', 400, 'INVALID_PATH'],
    ['ELOOP', 400, 'INVALID_PATH'],
    ['EIO', 403, 'PATH_FORBIDDEN'],
  ])('normalizes %s while reading the selected directory', async (code, status, kind) => {
    vi.mocked(fs.readdirSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('private diagnostic ' + outside), { code });
    });
    await expectError(route, status, kind);
  });

  it('does not return outside paths through generated mixed-separator traversals', () => {
    const piece = fc.tuple(fc.array(fc.constantFrom('a', 'q', '7', '_'), { minLength: 1, maxLength: 12 }),
      fc.constantFrom('/', '\\')).map(([characters, separator]) => characters.join('') + separator);
    const tail = fc.array(piece, { maxLength: 4 });
    const parents = fc.array(fc.constantFrom('/', '\\'), { minLength: 2, maxLength: 8 });
    fc.assert(fc.property(parents, tail, (parentSeparators, parts) => {
      const traversal = parentSeparators.map((separator) => '..' + separator).join('');
      const input = (process.platform === 'win32' ? '' : '../..' + '/') + traversal + parts.join('') + 'missing.json';
      expect(() => resolveSafeTracePath(input, [root], root))
        .toThrow(expect.objectContaining({ ...outsideError, name: PathSandboxError.name }));
    }), { numRuns: 128, seed: 20261125 });
  });
});
