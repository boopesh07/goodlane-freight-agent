import { assertDataFilesExist } from "@/lib/data/loaders";
import { runCallIntake, runEmailIntake } from "@/lib/intake/pipeline";
import { draftReply } from "@/lib/intake/draft";

export const maxDuration = 30;

/**
 * Draft a reply email. Re-runs the deterministic pipeline to get the facts, then
 * the LLM writes the prose strictly from those facts (the one generative step).
 */
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
    const result = body.kind === "email" ? runEmailIntake(body.id) : runCallIntake(body.id);
    const draft = await draftReply(result);
    return Response.json({ draft });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Draft failed" }, { status: 400 });
  }
}
