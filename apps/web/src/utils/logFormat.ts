export function formatLogLineForDisplay(text: string): { displayText: string; isJson: boolean } {
  const first = text.trimStart()[0];
  if (first === '{' || first === '[') {
    try {
      const parsed: unknown = JSON.parse(text);
      return { displayText: JSON.stringify(parsed, null, 2), isJson: true };
    } catch {
      // A fragment of an already multiline JSON file keeps its original indentation.
    }
  }
  return { displayText: text, isJson: false };
}
