export const MAX_PROMPT_LENGTH = 2000;

/**
 * Trims the prompt and checks its length in Unicode code points (the same unit PostgreSQL's
 * char_length uses), so an emoji counts as one character. Returns `null` when invalid.
 * NUL characters are rejected as well: PostgreSQL text columns cannot store them, so such a prompt
 * would otherwise fail only after the provider call.
 */
export function preparePrompt(raw: string): string | null {
  const prompt = raw.trim();
  const length = countCodePoints(prompt);
  if (length === 0 || length > MAX_PROMPT_LENGTH || prompt.includes('\u0000')) {
    return null;
  }
  return prompt;
}

/** Cache identity of a prompt: trim + lowercase + collapse whitespace runs into a single space. */
export function normalizePrompt(prompt: string): string {
  return prompt.trim().toLowerCase().replace(/\s+/g, ' ');
}

function countCodePoints(value: string): number {
  let count = 0;
  for (const _ of value) {
    count++;
  }
  return count;
}
