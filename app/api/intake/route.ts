import { assertDataFilesExist } from "@/lib/data/loaders";
import { runCallIntake, runEmailIntake } from "@/lib/intake/pipeline";

/**
 * Deterministic intake — no LLM. Extracts fields, resolves carrier + load via
 * the data tools, cross-references/validates, and assembles the answer (timeline,
 * best offer, compliance, recommendation) entirely in code.
 */
export async function POST(req: Request) {
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
    return Response.json({ result });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Intake failed" }, { status: 400 });
  }
}
