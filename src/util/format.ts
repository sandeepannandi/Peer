/**
 * Truncate `text` to at most `max` characters, appending an ellipsis when
 * truncated. Self-contained utility — not wired into the pipeline yet.
 */
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}
