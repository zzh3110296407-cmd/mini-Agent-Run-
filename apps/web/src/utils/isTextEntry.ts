export function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (
    target.isContentEditable || target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null
  );
}
