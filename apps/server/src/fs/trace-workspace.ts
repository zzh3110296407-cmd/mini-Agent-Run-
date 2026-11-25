import type { TraceWorkspaceBinding, TraceWorkspacePort } from '@mini-agent-run/agent';
import { basename, relative, sep } from 'node:path';
import { sliceTextContent } from './file-slice.js';
import {
  MAX_FILE_SLICE_BYTES, WORKSPACE_ROOT, listSessionTraceFiles, readSafeSessionFileWithMeta,
  resolveAllowedRoots, validateSessionBinding,
} from './path-sandbox.js';

export function createServerTraceWorkspace(
  session: TraceWorkspaceBinding, { baseDir = WORKSPACE_ROOT, maxFileSliceBytes = MAX_FILE_SLICE_BYTES } = {},
): TraceWorkspacePort {
  const binding = Object.freeze({ targetPath: session.targetPath, pathType: session.pathType });
  const roots = (allowedRoots: readonly string[]) => resolveAllowedRoots(allowedRoots, baseDir);
  return {
    binding,
    resolveTarget(allowedRoots) {
      const { realPath, kind } = validateSessionBinding(binding, roots(allowedRoots), baseDir);
      return { realPath, kind };
    },
    listFiles(allowedRoots, options) {
      return listSessionTraceFiles(binding, roots(allowedRoots), { ...options, baseDir });
    },
    readFile(file, allowedRoots, options) {
      const maxBytes = Math.min(maxFileSliceBytes, options?.maxBytes ?? maxFileSliceBytes);
      const { realPath, byteSize, content } = readSafeSessionFileWithMeta(binding, file, roots(allowedRoots), {
        baseDir, maxBytes,
      });
      const relativePath = binding.pathType === 'file' ? basename(realPath)
        : relative(binding.targetPath, realPath).split(sep).join('/');
      return { relativePath, byteSize, content };
    },
    sliceText: sliceTextContent,
  };
}
