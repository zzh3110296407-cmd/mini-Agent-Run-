export class ToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw new ToolError('TOOL_ABORTED', 'The tool was stopped.');
}

export function errorCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined;
}
