/**
 * Deterministic, dependency-free text helpers used by the call-extraction layer
 * (as candidate generation / prompt grounding) and by the unit tests. Keeping
 * these pure makes the messy bits — multi-rate bodies, garbled spoken MC
 * numbers — verifiable without an LLM in the loop.
 */

const NUMBER_WORDS: Record<string, string> = {
  zero: "0",
  oh: "0",
  o: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  for: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

const CORRECTION_HINTS = [
  "no wait",
  "no,",
  "sorry",
  "scratch that",
  "correction",
  "i mean",
  "i meant",
  "actually",
  "let me redo",
  "strike that",
];

export type DollarAmount = { value: number; index: number; context: string };

/** All `$` amounts found in free text, in order, with surrounding context. */
export function parseDollarAmounts(text: string): DollarAmount[] {
  if (!text) return [];
  const out: DollarAmount[] = [];
  const re = /\$\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const start = Math.max(0, m.index - 40);
    const end = Math.min(text.length, m.index + m[0].length + 40);
    out.push({ value, index: m.index, context: text.slice(start, end).trim() });
  }
  return out;
}

export type McNormalization = {
  mc: string | null;
  corrected: boolean;
  candidates: string[];
};

/**
 * Pull an MC number out of a (possibly garbled) call transcript. Handles
 * digit-by-digit spelling ("eight seven six..."), dashes, filler, and
 * mid-sentence corrections (last valid run wins).
 */
export function normalizeSpokenMc(text: string): McNormalization {
  if (!text) return { mc: null, corrected: false, candidates: [] };

  const lower = text.toLowerCase();
  const corrected = CORRECTION_HINTS.some((h) => lower.includes(h));

  // Convert spelled-out digits to numerals, drop dashes/dots between digits.
  const tokens = lower
    .replace(/[-.]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .map((t) => (t in NUMBER_WORDS ? NUMBER_WORDS[t] : t));

  // Build runs of consecutive digit-ish tokens.
  const runs: string[] = [];
  let current = "";
  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      current += t;
    } else if (current) {
      runs.push(current);
      current = "";
    }
  }
  if (current) runs.push(current);

  // MC numbers in this dataset are 5–7 digits. Prefer those, else widen.
  const mcLike = runs.filter((r) => r.length >= 5 && r.length <= 7);
  const candidates = mcLike.length > 0 ? mcLike : runs.filter((r) => r.length >= 4);

  return {
    mc: candidates.length > 0 ? candidates[candidates.length - 1] : null,
    corrected: corrected || candidates.length > 1,
    candidates,
  };
}
