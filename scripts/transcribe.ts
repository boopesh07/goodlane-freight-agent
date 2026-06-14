import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import { DATA_DIR, TRANSCRIPTS_PATH } from "../lib/data/paths";
import { modelNames } from "../lib/model";

/**
 * OFFLINE, run once. Transcribes every call recording with OpenAI's
 * gpt-4o-transcribe-diarize model (speaker-aware) and writes the JSON the
 * agent reads. The deployed app and CI never touch audio — they read the
 * committed transcripts. Idempotent: re-runs skip calls already done.
 *
 * Why diarization: rate-negotiation calls exchange MANY dollar figures between
 * the Goodlane dispatcher and the carrier. To pick the *carrier's own* offer
 * (and the correct best quote) we must know who said which number. Diarized
 * segments give each line a speaker label so extraction can attribute the quote
 * to the carrier rather than the broker's posted/anchor rate.
 */

type Segment = { speaker: string; text: string; start: number | null; end: number | null };

type TranscriptRecord = {
  call_id: string;
  type: string;
  file: string;
  transcript: string; // speaker-tagged, one line per segment
  segments: Segment[];
  speakers: string[];
  error?: string;
};

const CALLS_DIR = join(DATA_DIR, "call_recordings");

function tagTranscript(segments: Segment[]): string {
  return segments.map((s) => `[${s.speaker}] ${s.text.trim()}`).join("\n");
}

async function transcribeOne(
  client: OpenAI,
  filePath: string,
): Promise<{ transcript: string; segments: Segment[]; speakers: string[] }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res: any = await client.audio.transcriptions.create({
        file: createReadStream(filePath) as any,
        model: modelNames.transcribe,
        response_format: "diarized_json",
        // Required for inputs > 30s; normalizes loudness + VAD-splits per speaker.
        chunking_strategy: "auto",
      } as any);

      const rawSegments: any[] = res.segments ?? [];
      const segments: Segment[] = rawSegments.map((s) => ({
        speaker: String(s.speaker ?? "unknown"),
        text: String(s.text ?? ""),
        start: typeof s.start === "number" ? s.start : null,
        end: typeof s.end === "number" ? s.end : null,
      }));
      const speakers = Array.from(new Set(segments.map((s) => s.speaker)));
      const transcript = segments.length ? tagTranscript(segments) : String(res.text ?? "");
      return { transcript, segments, speakers };
    } catch (err) {
      if (attempt === 1) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return { transcript: "", segments: [], speakers: [] };
}

function parseFilename(file: string): { call_id: string; type: string } {
  // call_001_rate_negotiation.wav -> { call_001, rate_negotiation }
  const base = file.replace(/\.wav$/i, "");
  const m = base.match(/^(call_\d+)_(.+)$/);
  return { call_id: m ? m[1] : base, type: m ? m[2] : "unknown" };
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is required.");
    process.exit(1);
  }
  if (!existsSync(CALLS_DIR)) {
    console.error(`No call_recordings dir at ${CALLS_DIR}. Set DATA_DIR.`);
    process.exit(1);
  }
  mkdirSync("data", { recursive: true });

  const existing: TranscriptRecord[] = existsSync(TRANSCRIPTS_PATH)
    ? JSON.parse(readFileSync(TRANSCRIPTS_PATH, "utf8"))
    : [];
  const done = new Map(existing.map((r) => [r.call_id, r]));

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const files = readdirSync(CALLS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".wav"))
    .sort();

  console.log(`Found ${files.length} recordings. ${done.size} already transcribed.`);

  for (const file of files) {
    const { call_id, type } = parseFilename(file);
    if (done.has(call_id) && !done.get(call_id)!.error) continue;
    process.stdout.write(`Transcribing ${file} ... `);
    try {
      const { transcript, segments, speakers } = await transcribeOne(client, join(CALLS_DIR, file));
      done.set(call_id, { call_id, type, file, transcript, segments, speakers });
      console.log(`ok (${segments.length} segments, ${speakers.length} speakers)`);
    } catch (err) {
      const msg = (err as Error).message;
      done.set(call_id, { call_id, type, file, transcript: "", segments: [], speakers: [], error: msg });
      console.log(`FAILED: ${msg}`);
    }
    // Persist after each so a crash doesn't lose progress.
    writeFileSync(TRANSCRIPTS_PATH, JSON.stringify([...done.values()], null, 2));
  }

  const all = [...done.values()];
  const failed = all.filter((r) => r.error);
  console.log(`\nDone. ${all.length - failed.length} ok, ${failed.length} failed -> ${TRANSCRIPTS_PATH}`);
  if (failed.length) console.log("Failed:", failed.map((r) => r.file).join(", "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
