/**
 * Token estimate. Pure. Four characters per token is wrong for code and non-Latin scripts; a real
 * tokenizer is the fix and is noted as a limitation in the README. Callers pass an exact count when
 * they have one.
 */
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}
