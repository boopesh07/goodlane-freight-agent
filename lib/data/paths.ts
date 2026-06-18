import path from "node:path";

const root = process.cwd();

export const DATA_DIR = process.env.DATA_DIR ?? path.join(root, "goodlane-interview-dataset");
export const TRANSCRIPTS_PATH =
  process.env.TRANSCRIPTS_PATH ?? path.join(root, "data", "transcripts.json");
/**
 * Generated email intent enrichment (data/email_enrichment.json). Kept OUT of
 * the `paths` object below on purpose: it is an optional derived artifact, so
 * `assertDataFilesExist` must not require it — the loaders tolerate its absence
 * and fall back to the legacy/keyword intent path.
 */
export const EMAIL_ENRICHMENT_PATH =
  process.env.EMAIL_ENRICHMENT_PATH ?? path.join(root, "data", "email_enrichment.json");

export const paths = {
  carrierProfiles: path.join(DATA_DIR, "carrier_profiles.json"),
  carrierEmails: path.join(DATA_DIR, "carrier_emails.json"),
  loads: path.join(DATA_DIR, "loads.csv"),
  rateHistory: path.join(DATA_DIR, "rate_history.csv"),
  transcripts: TRANSCRIPTS_PATH,
} as const;
