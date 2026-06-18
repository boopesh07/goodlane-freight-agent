import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EMAIL_ENRICHMENT_PATH, paths } from "../lib/data/paths";
import { classifyEmailIntent } from "../lib/extraction/email-intent";
import type { CarrierEmail, NormalizedIntent } from "../lib/data/types";

/**
 * OFFLINE. Reads the provided carrier_emails.json and classifies each email's
 * intent into the normalized taxonomy, writing the result to a SEPARATE file
 * (data/email_enrichment.json) so the provided dataset stays pristine. The
 * loaders merge this onto emails at read time. Idempotent: already-classified
 * emails are skipped unless --force is passed.
 */

type EmailEnrichmentRow = {
  email_id: string;
  intent: NormalizedIntent;
  confidence: number;
  evidence: string;
};

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is required.");
    process.exit(1);
  }

  const force = process.argv.includes("--force");
  const emails = JSON.parse(readFileSync(paths.carrierEmails, "utf8")) as CarrierEmail[];

  const existing: EmailEnrichmentRow[] = existsSync(EMAIL_ENRICHMENT_PATH)
    ? (JSON.parse(readFileSync(EMAIL_ENRICHMENT_PATH, "utf8")) as EmailEnrichmentRow[])
    : [];
  const byId = new Map(existing.map((r) => [r.email_id, r]));

  let done = 0;
  for (const email of emails) {
    if (byId.has(email.email_id) && !force) continue;
    process.stdout.write(`Classifying ${email.email_id} ... `);
    const classification = await classifyEmailIntent(email.subject, email.body);
    if (!classification) {
      console.log("skip (no result)");
      continue;
    }
    byId.set(email.email_id, {
      email_id: email.email_id,
      intent: classification.value,
      confidence: classification.confidence,
      evidence: classification.evidence,
    });
    done++;
    console.log(`ok (${classification.value}@${classification.confidence.toFixed(2)})`);

    // Persist incrementally so a crash doesn't lose progress.
    mkdirSync(path.dirname(EMAIL_ENRICHMENT_PATH), { recursive: true });
    const rows = [...byId.values()].sort((a, b) => a.email_id.localeCompare(b.email_id));
    writeFileSync(EMAIL_ENRICHMENT_PATH, JSON.stringify(rows, null, 2));
  }

  console.log(`\nDone. Classified ${done} email(s) -> ${EMAIL_ENRICHMENT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
