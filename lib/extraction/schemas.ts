import { z } from "zod";

/**
 * Structured fields pulled from a diarized (speaker-tagged) call transcript.
 * Emails already arrive structured in carrier_emails.json; calls are raw audio,
 * so this is where the call-side "extract structured fields" work happens.
 */
export const CallExtraction = z.object({
  carrier_speaker: z
    .string()
    .nullable()
    .describe(
      "The speaker label (e.g. 'A'/'B') that is the CARRIER, not the Goodlane dispatcher. The carrier states their MC/company and is being quoted a load. null if undeterminable.",
    ),
  mc_number: z
    .string()
    .nullable()
    .describe("The MC number the carrier states, digits only. Honor mid-sentence corrections (last value wins). null if none."),
  company_name: z.string().nullable().describe("Carrier company name as heard. null if unclear."),
  load_reference: z.string().nullable().describe("Load id referenced, digits only. null if none."),
  origin_state: z
    .string()
    .nullable()
    .describe("Two-letter origin state of the lane the carrier is calling about (e.g. 'PA' from 'the PA to MD run'). null if not stated."),
  destination_state: z
    .string()
    .nullable()
    .describe("Two-letter destination state of the lane (e.g. 'MD'). null if not stated."),
  carrier_rate_usd: z
    .number()
    .nullable()
    .describe(
      "The CARRIER's own quoted/counter total rate in USD — a number spoken by carrier_speaker, NOT the dispatcher's posted/anchor rate. null if the carrier never states one.",
    ),
  dispatcher_rate_usd: z
    .number()
    .nullable()
    .describe("The rate the Goodlane dispatcher posts/anchors, if stated. For context only. null if absent."),
  equipment: z.string().nullable().describe("Equipment the carrier mentions, e.g. 'Box Truck'. null if absent."),
  available_location: z.string().nullable().describe("Where the carrier/driver is available. null if absent."),
  available_date: z.string().nullable().describe("ISO date (YYYY-MM-DD) if stated, else null."),
  questions: z.array(z.string()).describe("Open questions the carrier asks the broker. Empty array if none."),
});
export type CallExtraction = z.infer<typeof CallExtraction>;
