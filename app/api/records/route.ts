import path from "node:path";
import { assertDataFilesExist, findEmailById, findTranscriptById } from "@/lib/data/loaders";
import { paths } from "@/lib/data/paths";
import { listIngestionRecords } from "@/lib/ingestion/context";

function displayPath(abs: string): string {
  return path.relative(process.cwd(), abs);
}

export async function GET() {
  try {
    assertDataFilesExist();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Data files missing";
    return Response.json({ error: message }, { status: 500 });
  }

  const records = listIngestionRecords().map((r) => ({
    ...r,
    sourceFile: r.kind === "email" ? displayPath(paths.carrierEmails) : displayPath(paths.transcripts),
  }));
  return Response.json({ records });
}

export async function POST(req: Request) {
  try {
    assertDataFilesExist();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Data files missing";
    return Response.json({ error: message }, { status: 500 });
  }

  const body = (await req.json()) as { kind: "email" | "transcript"; id: string };
  if (body.kind === "email") {
    const email = findEmailById(body.id);
    if (!email) return Response.json({ error: "Email not found" }, { status: 404 });
    return Response.json({
      kind: "email",
      sourceFile: displayPath(paths.carrierEmails),
      record: email,
    });
  }

  const transcript = findTranscriptById(body.id);
  if (!transcript) return Response.json({ error: "Transcript not found" }, { status: 404 });
  const { segments: _segments, ...rest } = transcript;
  return Response.json({
    kind: "transcript",
    sourceFile: displayPath(paths.transcripts),
    record: rest,
  });
}
