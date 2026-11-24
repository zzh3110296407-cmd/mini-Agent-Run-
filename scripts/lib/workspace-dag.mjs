export const workspaceDependencies = {
  'packages/shared': [],
  'packages/ai': ['packages/shared'],
  'packages/agent': ['packages/shared', 'packages/ai'],
  'packages/tools': ['packages/shared', 'packages/agent'],
  'packages/debug-agent': ['packages/shared', 'packages/ai', 'packages/agent', 'packages/tools'],
  'apps/server': ['packages/shared', 'packages/ai', 'packages/agent', 'packages/tools', 'packages/debug-agent'],
  'apps/web': ['packages/shared'],
};

export function workspaceName(path) {
  return '@mini-agent-run/' + path.split('/')[1];
}

export function workspaceDirectory(path) {
  return /^(?:apps|packages)\/[^/]+/.exec(path)?.[0];
}
