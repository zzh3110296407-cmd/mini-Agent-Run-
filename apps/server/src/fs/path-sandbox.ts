import type { TraceFileEntry, TraceListResult, TraceWorkspaceBinding } from '@mini-agent-run/agent';
import { COMPUTER_ROOT_PATH, FsBrowseResponseSchema, type FsBrowseEntry, type FsBrowseResponse,
  type Session } from '@mini-agent-run/shared';
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync,
  readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUnrestrictedTraceRoots } from '../config/env.js';

export const WORKSPACE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const MAX_FILE_SLICE_BYTES = 20 * 1024 * 1024;

const windows = process.platform === 'win32';
const separators = windows ? /[/\\]/ : '/';
const maxPathLength = 4096;
const traceExtensions = new Set(['.json', '.jsonl', '.log', '.txt']);
const forbiddenSegments = new Set(['.env', '.git', '.npmrc', 'node_modules', '.ssh', '.aws', '.gnupg']);
const errors = {
  INVALID_PATH: [400, 'The trace path is invalid.'],
  PATH_NOT_A_DIRECTORY: [400, 'The trace path is not a directory.'],
  PATH_OUTSIDE_ALLOWED_ROOTS: [403, 'The trace path is outside the allowed roots.'],
  PATH_FORBIDDEN: [403, 'Access to the trace path is forbidden.'],
  PATH_NOT_FOUND: [404, 'The trace path does not exist.'],
  NO_ACCESSIBLE_ROOTS: [503, 'No configured trace root is accessible.'],
  UNSUPPORTED_TRACE_FILE: [400, 'The trace file extension is not supported.'],
  PATH_NOT_A_FILE: [400, 'The requested trace path is not a file.'],
  PATH_OUTSIDE_SESSION_SCOPE: [403, 'The requested file is outside the session target path.'],
  FILE_TOO_LARGE: [413, 'The trace file exceeds the maximum readable size.'],
} as const;

export class PathSandboxError extends Error {
  readonly statusCode: (typeof errors)[keyof typeof errors][0];

  constructor(readonly code: keyof typeof errors) {
    const [statusCode, message] = errors[code];
    super(message);
    this.name = 'PathSandboxError';
    this.statusCode = statusCode;
  }
}

export interface ResolvedTracePath {
  realPath: string;
  kind: 'file' | 'dir';
  rootPath: string;
}

function errorCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function fromFsError(error: unknown): PathSandboxError {
  switch (errorCode(error)) {
    case 'ENOENT': return new PathSandboxError('PATH_NOT_FOUND');
    case 'ENOTDIR': return new PathSandboxError('PATH_NOT_A_DIRECTORY');
    case 'EINVAL':
    case 'ENAMETOOLONG':
    case 'ELOOP': return new PathSandboxError('INVALID_PATH');
    default: return new PathSandboxError('PATH_FORBIDDEN');
  }
}

function withFsErrors<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw fromFsError(error);
  }
}

function pathKey(path: string) {
  const normalized = resolve(path);
  return windows ? normalized.toLowerCase() : normalized;
}

function isWithinRoot(candidate: string, root: string) {
  const candidateKey = pathKey(candidate);
  const rootKey = pathKey(root);
  return candidateKey === rootKey || candidateKey.startsWith(rootKey.endsWith(sep) ? rootKey : rootKey + sep);
}

function normalizeSegment(segment: string) {
  const lower = segment.toLowerCase();
  return windows ? lower.replace(/:[\s\S]*$/, '').replace(/[. ]+$/, '') : lower;
}

function isForbiddenSegment(segment: string) {
  const name = normalizeSegment(segment);
  return forbiddenSegments.has(name) || name.startsWith('.env.');
}

function isForbiddenPath(path: string) {
  const segments = path.split(separators).filter((part) => part && part !== '.').map(normalizeSegment);
  return segments.some((part, index) => isForbiddenSegment(part) || (
    part === 'offline-eval' && segments[index - 1] === 'database'
    && !(segments[index + 1] === 'trajerrbench' && segments[index + 2] === 'test')
  ));
}

function fitsBrowseContract(path: string) {
  return path.length <= maxPathLength && path === path.trim();
}

export function resolveAllowedRoots(rawRoots: readonly string[], baseDir = WORKSPACE_ROOT): string[] {
  if (isUnrestrictedTraceRoots(rawRoots)) {
    if (!windows) return ['/'];
    const drives: string[] = [];
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const drive = letter + ':\\';
      try {
        if (!statSync(drive, { throwIfNoEntry: false })?.isDirectory()) continue;
        opendirSync(drive).closeSync();
        drives.push(drive);
      } catch {
        // Ignore unmounted drives and drives that cannot be opened.
      }
    }
    if (drives.length === 0) throw new PathSandboxError('NO_ACCESSIBLE_ROOTS');
    return drives;
  }
  const roots = new Map<string, string>();
  for (const raw of rawRoots) {
    if (!raw.trim()) continue;
    try {
      const path = realpathSync.native(resolve(baseDir, raw));
      const key = pathKey(path);
      if (roots.has(key) || !fitsBrowseContract(path)) continue;
      opendirSync(path).closeSync();
      roots.set(key, path);
    } catch {
      // An unavailable root cannot authorize a request. Try the next configured root.
    }
  }
  if (roots.size === 0) throw new PathSandboxError('NO_ACCESSIBLE_ROOTS');
  return [...roots.values()];
}

function isUnresolvedLink(path: string) {
  try {
    return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
  } catch {
    return false;
  }
}

function locateCandidate(lexicalPath: string): {
  candidate: string; physicalAncestor?: string; failure?: PathSandboxError;
} {
  let ancestor = lexicalPath;
  let failure: PathSandboxError | undefined;
  while (true) {
    try {
      const physicalAncestor = realpathSync.native(ancestor);
      return { candidate: resolve(physicalAncestor, relative(ancestor, lexicalPath)), physicalAncestor, failure };
    } catch (error) {
      failure ??= fromFsError(error);
      if (errorCode(error) === 'ENOENT' && isUnresolvedLink(ancestor)) {
        // A dangling link cannot establish containment, even if its name lies inside a root.
        throw new PathSandboxError('PATH_OUTSIDE_ALLOWED_ROOTS');
      }
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return { candidate: lexicalPath, failure };
    ancestor = parent;
  }
}

function matchRoot(candidate: string, roots: readonly string[]) {
  let match: string | undefined;
  for (const root of roots) {
    if (isWithinRoot(candidate, root) && (match === undefined || pathKey(root).length > pathKey(match).length)) {
      match = root;
    }
  }
  if (match === undefined) throw new PathSandboxError('PATH_OUTSIDE_ALLOWED_ROOTS');
  return match;
}

function enforcePathBoundary(
  candidate: string, lexical: string, input: string, roots: readonly string[], requiredRealPath?: string,
) {
  const root = matchRoot(candidate, roots);
  if ([input, lexical, candidate].some(isForbiddenPath)) {
    throw new PathSandboxError('PATH_FORBIDDEN');
  }
  if (requiredRealPath !== undefined && pathKey(candidate) !== pathKey(requiredRealPath)) {
    throw new PathSandboxError('PATH_OUTSIDE_SESSION_SCOPE');
  }
  return root;
}

function inspectTracePath(inputPath: string, roots: readonly string[], baseDir: string, requiredRealPath?: string) {
  if (!inputPath.trim() || inputPath.includes('\0') || inputPath.length > maxPathLength) {
    throw new PathSandboxError('INVALID_PATH');
  }

  const lexicalPath = resolve(baseDir, inputPath);
  const volume = parse(lexicalPath).root;
  if (windows && volume.startsWith('\\\\')
    && !roots.some((root) => pathKey(parse(root).root) === pathKey(volume))) {
    throw new PathSandboxError('PATH_OUTSIDE_ALLOWED_ROOTS');
  }

  const { candidate, physicalAncestor, failure } = locateCandidate(lexicalPath);
  enforcePathBoundary(candidate, lexicalPath, inputPath, roots, requiredRealPath);
  if (failure) {
    // Windows can report ENOENT for a child of a regular file.
    if (failure.code === 'PATH_NOT_FOUND' && physicalAncestor !== undefined
      && !withFsErrors(() => statSync(physicalAncestor)).isDirectory()) {
      throw new PathSandboxError('PATH_NOT_A_DIRECTORY');
    }
    throw failure;
  }

  const realPath = withFsErrors(() => realpathSync.native(lexicalPath));
  const rootPath = enforcePathBoundary(realPath, lexicalPath, inputPath, roots, requiredRealPath);
  const metadata = withFsErrors(() => statSync(realPath, { bigint: true }));
  if (!metadata.isDirectory() && !metadata.isFile()) throw new PathSandboxError('INVALID_PATH');
  return { realPath, rootPath, metadata };
}

export function resolveSafeTracePath(
  inputPath: string, roots: readonly string[], baseDir = WORKSPACE_ROOT,
): ResolvedTracePath {
  const { realPath, rootPath, metadata } = inspectTracePath(inputPath, roots, baseDir);
  return { realPath, rootPath, kind: metadata.isDirectory() ? 'dir' : 'file' };
}

function hasTraceExtension(path: string) {
  return traceExtensions.has(extname(path).toLowerCase());
}

function assertTraceExtension(inputPath: string, realPath: string) {
  if (!hasTraceExtension(inputPath) || !hasTraceExtension(realPath)) {
    throw new PathSandboxError('UNSUPPORTED_TRACE_FILE');
  }
}

export function resolveSessionTargetPath(
  inputPath: string, roots: readonly string[], baseDir = WORKSPACE_ROOT,
): ResolvedTracePath {
  if (inputPath === COMPUTER_ROOT_PATH) throw new PathSandboxError('INVALID_PATH');
  const target = resolveSafeTracePath(inputPath, roots, baseDir);
  if (!fitsBrowseContract(target.realPath)) throw new PathSandboxError('INVALID_PATH');
  if (target.kind === 'file') assertTraceExtension(inputPath, target.realPath);
  return target;
}

function inspectSessionBinding(session: TraceWorkspaceBinding, roots: readonly string[], baseDir: string) {
  const target = inspectTracePath(session.targetPath, roots, baseDir, session.targetPath);
  if (session.pathType === 'file' && !target.metadata.isFile()) throw new PathSandboxError('PATH_NOT_A_FILE');
  if (session.pathType === 'dir' && !target.metadata.isDirectory()) throw new PathSandboxError('PATH_NOT_A_DIRECTORY');
  return target;
}

export function validateSessionBinding(
  session: TraceWorkspaceBinding, roots: readonly string[], baseDir = WORKSPACE_ROOT,
): ResolvedTracePath {
  const { realPath, rootPath } = inspectSessionBinding(session, roots, baseDir);
  return { realPath, rootPath, kind: session.pathType };
}

function selectSessionFile(
  session: TraceWorkspaceBinding, requestedFile: string | undefined, roots: readonly string[], baseDir: string,
) {
  const target = inspectSessionBinding(session, roots, baseDir);

  if (requestedFile === undefined) {
    if (session.pathType === 'dir') throw new PathSandboxError('INVALID_PATH');
    assertTraceExtension(session.targetPath, target.realPath);
    return target;
  }

  const directorySession = session.pathType === 'dir';
  const requestBase = directorySession ? target.realPath : dirname(target.realPath);
  try {
    const file = inspectTracePath(
      requestedFile, directorySession ? [target.realPath] : roots, requestBase,
      directorySession ? undefined : target.realPath,
    );
    enforcePathBoundary(file.realPath, resolve(requestBase, requestedFile), requestedFile, roots);
    if (!file.metadata.isFile()) throw new PathSandboxError('PATH_NOT_A_FILE');
    assertTraceExtension(requestedFile, file.realPath);
    return file;
  } catch (error) {
    if (error instanceof PathSandboxError && error.code === 'PATH_OUTSIDE_ALLOWED_ROOTS') {
      throw new PathSandboxError('PATH_OUTSIDE_SESSION_SCOPE');
    }
    throw error;
  }
}

export function readSafeSessionFileWithMeta(
  session: TraceWorkspaceBinding, requestedFile: string | undefined,
  roots: readonly string[], { baseDir = WORKSPACE_ROOT, maxBytes = MAX_FILE_SLICE_BYTES } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_FILE_SLICE_BYTES) {
    throw new RangeError('Invalid file-slice byte limit.');
  }
  const { realPath, metadata: preStat } = selectSessionFile(session, requestedFile, roots, baseDir);
  // A nonblocking read-only open also permits fstat to reject a replaced FIFO on POSIX.
  const fd = withFsErrors(() => openSync(realPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)));
  try {
    const opened = withFsErrors(() => fstatSync(fd, { bigint: true }));
    if (!opened.isFile()) throw new PathSandboxError('PATH_NOT_A_FILE');
    if (opened.dev !== preStat.dev || opened.ino !== preStat.ino) throw new PathSandboxError('PATH_FORBIDDEN');
    if (opened.size > BigInt(maxBytes)) throw new PathSandboxError('FILE_TOO_LARGE');

    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - bytesRead));
      const count = withFsErrors(() => readSync(fd, chunk, 0, chunk.length, null));
      if (count === 0) {
        return { realPath, byteSize: bytesRead, content: Buffer.concat(chunks, bytesRead).toString('utf8') };
      }
      bytesRead += count;
      chunks.push(chunk.subarray(0, count));
    }
    throw new PathSandboxError('FILE_TOO_LARGE');
  } finally {
    withFsErrors(() => closeSync(fd));
  }
}

export function readSafeSessionFile(
  session: Pick<Session, 'targetPath' | 'pathType'>, requestedFile: string | undefined, roots: readonly string[],
  options?: { baseDir?: string; maxBytes?: number },
): string {
  return readSafeSessionFileWithMeta(session, requestedFile, roots, options).content;
}

export function listSessionTraceFiles(
  session: TraceWorkspaceBinding, roots: readonly string[],
  { baseDir = WORKSPACE_ROOT, maxFiles = 200, maxDepth = 5 } = {},
): TraceListResult {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 200
    || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 5) {
    throw new RangeError('Invalid trace listing limits.');
  }
  const target = inspectSessionBinding(session, roots, baseDir);
  const toEntry = (file: typeof target, relativePath: string): TraceFileEntry => ({
    relativePath, kind: 'file', byteSize: Number(file.metadata.size), modifiedAt: file.metadata.mtime.toISOString(),
  });
  if (session.pathType === 'file') {
    if (!fitsBrowseContract(target.realPath)) throw new PathSandboxError('INVALID_PATH');
    assertTraceExtension(session.targetPath, target.realPath);
    return { entries: [toEntry(target, basename(target.realPath))], truncated: false };
  }

  const visited = new Set<string>();
  const files = new Map<string, TraceFileEntry>();
  let truncated = false;
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  function visit(dir: string, depth: number) {
    const key = pathKey(dir);
    if (visited.has(key)) return;
    visited.add(key);
    const names = withFsErrors(() => readdirSync(dir, { withFileTypes: true }))
      .map(({ name }) => name).sort(compare);
    for (const name of names) {
      if (name.startsWith('.') || isForbiddenSegment(name)) continue;
      const input = join(dir, name);
      try {
        const child = inspectTracePath(input, [target.realPath], baseDir);
        enforcePathBoundary(child.realPath, input, input, roots);
        const segments = relative(target.realPath, child.realPath).split(sep);
        if (segments.some((segment) => segment.startsWith('.'))) continue;
        if (child.metadata.isDirectory()) {
          if (depth < maxDepth) visit(child.realPath, depth + 1);
          else if (!visited.has(pathKey(child.realPath))) truncated = true;
        } else if (hasTraceExtension(name) && hasTraceExtension(child.realPath) && fitsBrowseContract(child.realPath)) {
          const relativePath = segments.join('/');
          if (files.has(relativePath)) continue;
          if (files.size >= maxFiles) {
            truncated = true;
            return;
          }
          files.set(relativePath, toEntry(child, relativePath));
        }
      } catch (error) {
        if (!(error instanceof PathSandboxError)) throw error;
      }
      if (files.size >= maxFiles && truncated) return;
    }
  }
  visit(target.realPath, 0);
  const entries = [...files.values()].sort((a, b) => compare(a.relativePath, b.relativePath));
  return { entries, truncated };
}

export function browseSafeDirectory(
  inputPath: string | undefined, roots: readonly string[], baseDir = WORKSPACE_ROOT,
  { unrestricted = false, resolveFile = false } = {},
): FsBrowseResponse {
  const firstRoot = roots[0];
  if (firstRoot === undefined) throw new PathSandboxError('NO_ACCESSIBLE_ROOTS');

  const hasComputerRoot = unrestricted && windows && roots.length > 1;
  if (inputPath === COMPUTER_ROOT_PATH) {
    if (hasComputerRoot) {
      return FsBrowseResponseSchema.parse({ currentPath: COMPUTER_ROOT_PATH, parentPath: null, allowedRoots: roots,
        entries: roots.map((path) => ({ name: path, path, kind: 'dir' })) });
    }
    if (!unrestricted || windows) throw new PathSandboxError('INVALID_PATH');
  }
  const defaultStart = () => {
    const base = resolve(baseDir);
    const fixtures = join(base, 'data', 'fixtures');
    try {
      return statSync(fixtures, { throwIfNoEntry: false })?.isDirectory() ? fixtures : base;
    } catch {
      return base;
    }
  };
  const path = inputPath === COMPUTER_ROOT_PATH ? firstRoot : inputPath ?? (unrestricted ? defaultStart() : firstRoot);
  const { realPath, rootPath, kind } = resolveSafeTracePath(path, roots, baseDir);
  let selectedFile: string | undefined;
  if (kind === 'file') {
    if (!resolveFile) throw new PathSandboxError('PATH_NOT_A_DIRECTORY');
    assertTraceExtension(path, realPath);
    if (!fitsBrowseContract(realPath)) throw new PathSandboxError('INVALID_PATH');
    selectedFile = realPath;
  }

  const currentPath = selectedFile === undefined ? realPath : dirname(selectedFile);
  const parentPath = pathKey(currentPath) === pathKey(rootPath) ? (hasComputerRoot ? COMPUTER_ROOT_PATH : null)
    : dirname(currentPath);
  // Shared path fields trim space. Avoid returning any navigation value that would then identify a different path.
  if (!fitsBrowseContract(currentPath) || (parentPath !== null && !fitsBrowseContract(parentPath))) {
    throw new PathSandboxError('INVALID_PATH');
  }

  const selectedName = selectedFile === undefined ? undefined : basename(selectedFile);
  const selectedDotfile = selectedName?.startsWith('.') ? selectedName : undefined;
  const entries: FsBrowseEntry[] = [];
  for (const entry of withFsErrors(() => readdirSync(currentPath, { withFileTypes: true }))) {
    const name = entry.name.trim();
    const hidden = entry.name.startsWith('.');
    if (!name || isForbiddenSegment(entry.name) || (hidden && entry.name !== selectedDotfile)) continue;

    try {
      const { realPath: path, metadata } = inspectTracePath(join(currentPath, entry.name), roots, baseDir);
      if (!fitsBrowseContract(path)) continue;
      if (hidden && (path !== selectedFile || !metadata.isFile())) continue;
      if (!hidden && selectedDotfile !== undefined && path === selectedFile) continue;
      const modifiedAt = metadata.mtime.toISOString();
      if (metadata.isDirectory()) {
        entries.push({ name, path, kind: 'dir', modifiedAt });
      } else if (hasTraceExtension(entry.name) && hasTraceExtension(path)) {
        entries.push({ name, path, kind: 'file', byteSize: Number(metadata.size), modifiedAt });
      }
    } catch (error) {
      if (!(error instanceof PathSandboxError)) throw error;
    }
  }

  const confirmed = resolveSafeTracePath(currentPath, roots, baseDir);
  if (confirmed.kind !== 'dir') throw new PathSandboxError('PATH_NOT_A_DIRECTORY');
  if (pathKey(confirmed.realPath) !== pathKey(currentPath)) throw new PathSandboxError('PATH_FORBIDDEN');

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return FsBrowseResponseSchema.parse({ currentPath, parentPath, allowedRoots: roots, entries,
    ...(selectedFile === undefined ? {} : { selectedFile }) });
}
