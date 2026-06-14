import { assertDataFilesExist } from "@/lib/data/loaders";
import { type IntakeEvent, processIntake } from "@/lib/intake/process";

export const maxDuration = 60;

/**
 * On-demand intake: runs the deterministic pipeline (resolution → cross-reference
 * → rate math → timeline → recommendation, all in code — no LLM, no API key) and
 * streams NDJSON progress events so the UI can show each lookup as it happens.
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

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: IntakeEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      try {
        await processIntake(body.kind!, body.id!, emit);
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : "Intake failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
