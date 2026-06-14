import { assertDataFilesExist } from "@/lib/data/loaders";
import { draftReply } from "@/lib/intake/draft";
import { processIntake } from "@/lib/intake/process";

export const maxDuration = 120;

/** Draft a reply — re-runs the full on-demand intake pipeline, then LLM prose. */
export async function POST(req: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "OPENAI_API_KEY is not configured" }, { status: 500 });
  }
  try {
    assertDataFilesExist();
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Data files missing" }, { status: 500 });
  }

  const body = (await req.json()) as { kind?: "email" | "call"; id?: string };
  if (!body.id || !body.kind) {
    return Response.json({ error: "Provide { kind: 'email' | 'call', id }" }, { status: 400 });
  }

  try {
    const result = await processIntake(body.kind, body.id, () => {});
    const draft = await draftReply(result);
    return Response.json({ draft });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Draft failed" }, { status: 400 });
  }
}
