import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { TRANSCRIPTS_PATH } from "../lib/data/paths";
import { extractCall } from "../lib/extraction/llm";

/**
 * OFFLINE, run after transcribe.ts. Reads data/transcripts.json, runs LLM
 * structured extraction on each diarized transcript, and writes the structured
 * fields back onto each record (`extracted` + `extraction_warnings`). This is
 * the call-side half of "extract structured fields from both sources" — emails
 * already arrive structured in carrier_emails.json. Idempotent: pass --force to
 * re-extract records that already have an `extracted` block.
 */

type Record = {
  call_id: string;
  transcript: string;
  extracted?: unknown;
  extraction_warnings?: string[];
  [k: string]: unknown;
};

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is required.");
    process.exit(1);
  }
  if (!existsSync(TRANSCRIPTS_PATH)) {
    console.error(`No transcripts at ${TRANSCRIPTS_PATH}. Run "npm run transcribe" first.`);
    process.exit(1);
  }

  const force = process.argv.includes("--force");
  const records = JSON.parse(readFileSync(TRANSCRIPTS_PATH, "utf8")) as Record[];

  let done = 0;
  for (const rec of records) {
    if (rec.extracted && !force) continue;
    if (!rec.transcript?.trim()) continue;
    process.stdout.write(`Extracting ${rec.call_id} ... `);
    const { data, warnings } = await extractCall(rec.transcript);
    rec.extracted = data;
    rec.extraction_warnings = warnings;
    done++;
    console.log(
      data
        ? `ok (mc=${data.mc_number ?? "-"}, carrier_rate=${data.carrier_rate_usd ?? "-"}${warnings.length ? `, warns=${warnings.join("|")}` : ""})`
        : `no data (${warnings.join("|")})`,
    );
    // Persist incrementally so a crash doesn't lose progress.
    writeFileSync(TRANSCRIPTS_PATH, JSON.stringify(records, null, 2));
  }

  console.log(`\nDone. Extracted ${done} call(s) -> ${TRANSCRIPTS_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
