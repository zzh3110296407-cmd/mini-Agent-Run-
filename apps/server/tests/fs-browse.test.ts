import { FsBrowseResponseSchema } from '@mini-agent-run/shared';
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
      expect(data.parentPath).toBeNull();
      expect(data.entries.map(({ name }) => name)).not.toContain('.gitkeep');
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

  it('validates safe files and distinguishes missing paths from non-directories', async () => {
    const file = join(root, 'valid.json');
    fs.writeFileSync(file, '{}');
    expect(resolveSafeTracePath(file, [root])).toEqual({ realPath: file, rootPath: root, kind: 'file' });
    await expectError(browseUrl(file), 400, 'PATH_NOT_A_DIRECTORY');
    await expectError(browseUrl(join(file, 'child')), 400, 'PATH_NOT_A_DIRECTORY');
    await expectError(browseUrl(join(root, 'missing-sub')), 404, 'PATH_NOT_FOUND');
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
