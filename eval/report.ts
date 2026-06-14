/** Tiny shared reporting helpers for the eval harnesses (no deps). */

export type Check = { label: string; pass: boolean; detail?: string };

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export function rule(width = 64): string {
  return "—".repeat(width);
}

/** Build a check, recording a human-readable detail on failure. */
export function eq<T>(label: string, actual: T, expected: T): Check {
  const pass = actual === expected;
  return { label, pass, detail: pass ? undefined : `expected ${fmt(expected)}, got ${fmt(actual)}` };
}

export function fmt(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

export function printCase(id: string, checks: Check[], description?: string): boolean {
  const failed = checks.filter((c) => !c.pass);
  const pass = failed.length === 0;
  const tag = pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  console.log(`${tag}  ${BOLD}${id}${RESET}`);
  if (description) console.log(`      ${DIM}${description}${RESET}`);
  for (const c of checks) {
    const mark = c.pass ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const detail = c.pass ? "" : `  ${DIM}(${c.detail})${RESET}`;
    console.log(`      ${mark} ${c.label}${detail}`);
  }
  console.log();
  return pass;
}

export function printScore(label: string, passed: number, total: number): number {
  const score = total === 0 ? 1 : passed / total;
  const color = score === 1 ? GREEN : RED;
  console.log(rule());
  console.log(`${BOLD}${label}:${RESET} ${color}${passed}/${total} (${(score * 100).toFixed(0)}%)${RESET}`);
  return score;
}

export function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}
