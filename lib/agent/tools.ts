import { tool } from "ai";
import { z } from "zod";
import {
  findCarrierProfile,
  findLoad,
  findLoadFuzzy,
  getEmailHistoryBefore,
  getRateHistoryBefore,
  isBefore,
  loadTranscripts,
  searchLoads,
} from "@/lib/data/loaders";
import type { CallTranscript } from "@/lib/data/types";

const timestampSchema = z
  .string()
  .describe("ISO 8601 timestamp, e.g. 2026-05-21T12:00:00Z. Results are strictly BEFORE this time.");

export const agentTools = {
  get_carrier_profile: tool({
    description:
      "Look up a carrier master profile from carrier_profiles.json by MC number, company name, or email. " +
      "Resolution order: MC (exact) → email (exact) → company name (exact, then substring, then FUZZY). " +
      "Fuzzy name matching tolerates legal suffixes, word order, spoken-out initials ('s m r' → SMR), and misspellings. " +
      "If an MC lookup returns nothing, retry with company_name — a profile should almost always exist.",
    parameters: z.object({
      mc_number: z.string().optional().describe("Motor carrier number, with or without formatting"),
      company_name: z
        .string()
        .optional()
        .describe("Carrier company name; fuzzy-matched if no exact match exists"),
      email: z.string().optional().describe("Carrier contact email"),
    }),
    execute: async ({ mc_number, company_name, email }) => {
      if (!mc_number && !company_name && !email) {
        return { error: "Provide at least one of mc_number, company_name, or email." };
      }
      const profile = findCarrierProfile({ mc_number, company_name, email });
      if (!profile) {
        return {
          found: false,
          profile: null,
          hint: company_name
            ? "No fuzzy match above threshold. Try a shorter/cleaner carrier name."
            : "No match by MC/email. Retry with company_name for a fuzzy lookup.",
        };
      }
      return { found: true, profile };
    },
  }),

  get_load: tool({
    description:
      "Fetch a load from loads.csv. Resolution order: (1) exact load_id; (2) if the id misses, nearest valid ids as `suggestions` (carriers often misspell load numbers); (3) if NO load_id is available, structured search by lane/equipment/rate/status/pickup — e.g. a carrier calls about 'the PA→MD box truck posted at $440' with no number. Provide whatever structured fields you know; lane + equipment anchor the search and rate/status/pickup refine it.",
    parameters: z.object({
      load_id: z.string().optional().describe("Load board id, e.g. 29372343"),
      origin_state: z.string().optional().describe("Two-letter origin state, e.g. PA"),
      destination_state: z.string().optional().describe("Two-letter destination state, e.g. MD"),
      equipment_type: z.string().optional().describe("Equipment type, e.g. Box Truck (partial ok)"),
      status: z
        .enum(["open", "covered", "delivered", "cancelled"])
        .optional()
        .describe("Load status filter, usually 'open' for active inquiries"),
      offered_rate: z.number().optional().describe("Approx posted/offered rate in USD, e.g. 440"),
      rate_tolerance: z.number().optional().describe("Max $ distance from offered_rate to match (default 50)"),
      pickup_date: z.string().optional().describe("Pickup date YYYY-MM-DD"),
    }),
    execute: async ({
      load_id,
      origin_state,
      destination_state,
      equipment_type,
      status,
      offered_rate,
      rate_tolerance,
      pickup_date,
    }) => {
      // 1. Exact id lookup.
      if (load_id) {
        const load = findLoad(load_id);
        if (load) return { found: true, matched_by: "load_id", load };
        const suggestions = findLoadFuzzy(load_id);
        if (suggestions.length) {
          return {
            found: false,
            load: null,
            matched_by: "fuzzy_id",
            suggestions,
            hint: "Exact load not found. Likely a misspelled load number — verify against these near-matches and the carrier's lane/equipment before answering.",
          };
        }
      }

      // 2. Structured fallback when there's no id (or the id was unrecoverable).
      const hasStructured =
        origin_state || destination_state || equipment_type || status || offered_rate != null || pickup_date;
      if (hasStructured) {
        const { matches, relaxed, topConfidence, needsHumanVerification } = searchLoads({
          originState: origin_state,
          destinationState: destination_state,
          equipmentType: equipment_type,
          status,
          offeredRate: offered_rate,
          rateTolerance: rate_tolerance,
          pickupDate: pickup_date,
        });

        const loads = matches.map((m) => ({
          ...m.load,
          confidence: m.confidence,
          confidence_pct: `${Math.round(m.confidence * 100)}%`,
          matched_criteria: m.matched,
          missed_criteria: m.missed,
        }));

        let hint: string;
        if (loads.length === 0) {
          hint = "No load matches the structured criteria. Ask the carrier for the load number, lane, or pickup date.";
        } else if (needsHumanVerification) {
          hint =
            `Best match is LOW CONFIDENCE (${Math.round(topConfidence * 100)}%)` +
            (relaxed.length ? `, had to relax [${relaxed.join(", ")}]` : "") +
            `. DO NOT adopt this load automatically — present it to the broker with its confidence and ask them to confirm before quoting or replying. Only proceed once a human verifies.`;
        } else if (relaxed.length) {
          hint = `Matched at ${Math.round(topConfidence * 100)}% after relaxing [${relaxed.join(", ")}]. Confirm with the broker if more than one candidate is plausible.`;
        } else {
          hint = `Confident structured match (${Math.round(topConfidence * 100)}%). If more than one candidate, confirm which the carrier means.`;
        }

        return {
          found: loads.length > 0,
          matched_by: "structured_search",
          count: loads.length,
          relaxed_filters: relaxed,
          top_confidence: topConfidence,
          needs_human_verification: needsHumanVerification,
          loads,
          hint,
        };
      }

      return {
        found: false,
        load: null,
        error: "Provide a load_id or structured attributes (lane/equipment/rate/status/pickup) to search.",
      };
    },
  }),

  get_rate_history: tool({
    description:
      "Return weekly lane rate history rows from rate_history.csv that occurred strictly BEFORE the given timestamp. Optionally filter by lane and equipment.",
    parameters: z.object({
      before_timestamp: timestampSchema,
      origin_state: z.string().optional().describe("Two-letter origin state, e.g. PA"),
      destination_state: z.string().optional().describe("Two-letter destination state, e.g. NJ"),
      equipment_type: z.string().optional().describe("Equipment type, e.g. Box Truck"),
    }),
    execute: async ({ before_timestamp, origin_state, destination_state, equipment_type }) => {
      const rows = getRateHistoryBefore({
        beforeTimestamp: before_timestamp,
        originState: origin_state,
        destinationState: destination_state,
        equipmentType: equipment_type,
      }).reverse();

      const latest = rows[0] ?? null;
      return {
        before_timestamp,
        count: rows.length,
        latest_week: latest,
        rows: rows.slice(0, 52),
      };
    },
  }),

  get_email_history: tool({
    description:
      "Return carrier emails from carrier_emails.json with timestamp strictly BEFORE the given time. Optionally filter by MC, load, or sender email.",
    parameters: z.object({
      before_timestamp: timestampSchema,
      mc_number: z.string().optional(),
      load_reference: z.string().optional(),
      from_email: z.string().optional(),
    }),
    execute: async ({ before_timestamp, mc_number, load_reference, from_email }) => {
      const emails = getEmailHistoryBefore({
        beforeTimestamp: before_timestamp,
        mc_number,
        load_reference,
        from_email,
      }).reverse();

      return {
        before_timestamp,
        count: emails.length,
        emails: emails.slice(0, 50),
      };
    },
  }),

  get_transcript: tool({
    description:
      "Retrieve call transcript(s) from data/transcripts.json. Each call includes pre-extracted structured fields (carrier mc_number, company_name, carrier_rate_usd vs dispatcher_rate_usd, equipment, availability, load_reference, questions) plus per-field confidence scores and evidence from LLM extraction. Filter by call_id and/or return calls recorded strictly BEFORE the given timestamp.",
    parameters: z.object({
      call_id: z.string().optional().describe("Call id, e.g. call_001"),
      before_timestamp: timestampSchema.optional(),
      search_text: z
        .string()
        .optional()
        .describe("Case-insensitive substring search in transcript text (e.g. MC number or lane)"),
    }),
    execute: async ({ call_id, before_timestamp, search_text }) => {
      let transcripts: CallTranscript[] = loadTranscripts();

      if (call_id) {
        transcripts = transcripts.filter((t) => t.call_id === call_id);
      }
      if (before_timestamp) {
        transcripts = transcripts.filter((t) => isBefore(t.recorded_at, before_timestamp));
      }
      if (search_text) {
        const needle = search_text.toLowerCase();
        transcripts = transcripts.filter((t) => t.transcript.toLowerCase().includes(needle));
      }

      transcripts.sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at));

      return {
        before_timestamp: before_timestamp ?? null,
        count: transcripts.length,
        note:
          "Call recorded_at timestamps are synthetic ordering keys (call_001 earliest) for timeline reconstruction.",
        transcripts: transcripts.slice(0, 20).map(({ segments: _s, ...rest }) => rest),
      };
    },
  }),

  draft_email: tool({
    description:
      "Compose a draft reply email to a carrier — to quote a rate or confirm next steps. Returns a structured draft only; it is NEVER sent. Use this when the broker asks to reply/quote/confirm. Pass the facts you verified (load, rate, lane); only quote a rate the broker has approved or that you are explicitly told to offer. If the load/carrier match was low-confidence, do NOT quote a firm rate — set purpose to 'request_confirmation' and ask the carrier to confirm the load first.",
    parameters: z.object({
      to_email: z.string().optional().describe("Carrier contact email, if known"),
      to_name: z.string().optional().describe("Carrier contact / company name for the greeting"),
      load_id: z.string().optional().describe("Load id this reply concerns"),
      lane: z.string().optional().describe("Lane summary, e.g. 'Reading, PA → Newark, NJ'"),
      purpose: z
        .enum(["quote_rate", "confirm_next_steps", "request_confirmation", "decline"])
        .describe("What this email does"),
      rate_usd: z.number().optional().describe("Rate to quote/confirm in USD (only when approved)"),
      key_points: z
        .array(z.string())
        .optional()
        .describe("Bullet facts to include (pickup window, equipment, compliance note, etc.)"),
      next_steps: z.string().optional().describe("The action you want the carrier to take next"),
    }),
    execute: async ({ to_email, to_name, load_id, lane, purpose, rate_usd, key_points, next_steps }) => {
      const greeting = `Hi ${to_name ?? "there"},`;
      const ref = [load_id ? `load ${load_id}` : null, lane].filter(Boolean).join(" — ");

      const lead: Record<typeof purpose, string> = {
        quote_rate:
          rate_usd != null
            ? `Thanks for reaching out${ref ? ` on ${ref}` : ""}. We can offer $${rate_usd} all-in for this run.`
            : `Thanks for reaching out${ref ? ` on ${ref}` : ""}. Here is where we land on rate:`,
        confirm_next_steps: `Confirming next steps${ref ? ` on ${ref}` : ""}.`,
        request_confirmation: `Thanks for the call${ref ? ` about ${ref}` : ""}. Before we quote, can you confirm this is the correct load? We want to make sure we are pricing the right lane.`,
        decline: `Thanks for reaching out${ref ? ` on ${ref}` : ""}. Unfortunately we can't move forward on this one right now.`,
      };

      const bodyLines = [greeting, "", lead[purpose]];
      if (key_points?.length) {
        bodyLines.push("", ...key_points.map((p) => `• ${p}`));
      }
      if (next_steps) {
        bodyLines.push("", next_steps);
      }
      bodyLines.push("", "Best,", "Goodlane Dispatch");

      const subject =
        purpose === "request_confirmation"
          ? `Confirming load details${load_id ? ` — ${load_id}` : ""}`
          : purpose === "quote_rate"
            ? `Rate${load_id ? ` for load ${load_id}` : ""}${rate_usd != null ? ` — $${rate_usd}` : ""}`
            : purpose === "decline"
              ? `Re: ${ref || "your inquiry"}`
              : `Next steps${load_id ? ` — load ${load_id}` : ""}`;

      return {
        status: "draft (not sent — broker must review and send)",
        to: to_email ?? null,
        subject,
        body: bodyLines.join("\n"),
      };
    },
  }),
};
