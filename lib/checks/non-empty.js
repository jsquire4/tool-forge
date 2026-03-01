// Adapted from evalkit by wkhori (https://github.com/wkhori/evalkit)
// MIT License — see LICENSE

export const DEFAULT_COP_OUT_PHRASES = [
  "i'm sorry",
  "i cannot",
  "i can't",
  "i don't know",
  "i am not able to",
  "as an ai",
  "as a language model",
  "i don't have access",
  "i don't have information",
  "i'm not able to",
  "i am unable to",
  "unfortunately, i",
  "i apologize",
];

/**
 * @param {{responseText: string, copOutPhrases?: string[]}} input
 * @returns {import('./types.js').EvalResult}
 */
export function nonEmpty({ responseText, copOutPhrases = DEFAULT_COP_OUT_PHRASES }) {
  if (!responseText || responseText.trim().length === 0) {
    return { pass: false, reason: 'Response is empty' };
  }
  const lower = responseText.toLowerCase();
  const found = copOutPhrases.find(phrase => lower.includes(phrase.toLowerCase()));
  if (found) {
    return { pass: false, reason: `Response contains cop-out phrase: "${found}"` };
  }
  return { pass: true };
}
