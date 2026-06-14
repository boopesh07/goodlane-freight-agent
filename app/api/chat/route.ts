import { streamText } from "ai";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { agentTools } from "@/lib/agent/tools";
import { assertDataFilesExist } from "@/lib/data/loaders";
import {
  buildEmailIngestionContext,
  buildTranscriptIngestionContext,
  formatIngestionSystemContext,
} from "@/lib/ingestion/context";
import { getAgentModel } from "@/lib/model";

export const maxDuration = 60;

type ChatMode = "query" | "email" | "transcript";

export async function POST(req: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "OPENAI_API_KEY is not configured" }, { status: 500 });
  }

  try {
    assertDataFilesExist();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Data files missing";
    return Response.json({ error: message }, { status: 500 });
  }

  const body = (await req.json()) as {
    messages?: { role: "user" | "assistant"; content: string }[];
    mode?: ChatMode;
    asOf?: string;
    emailId?: string;
    callId?: string;
  };

  const messages = body.messages ?? [];
  const mode: ChatMode = body.mode ?? "query";
  const asOf = body.asOf?.trim() || "2026-05-25T23:59:59Z";

  let system = SYSTEM_PROMPT;

  if (mode === "email" && body.emailId) {
    try {
      const ctx = buildEmailIngestionContext(body.emailId);
      system += formatIngestionSystemContext(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid email ingestion";
      return Response.json({ error: message }, { status: 400 });
    }
  } else if (mode === "transcript" && body.callId) {
    try {
      const ctx = buildTranscriptIngestionContext(body.callId);
      system += formatIngestionSystemContext(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid transcript ingestion";
      return Response.json({ error: message }, { status: 400 });
    }
  } else {
    system += `\n\nThe broker is asking as of ${asOf}. Use this as before_timestamp when calling get_email_history, get_rate_history, and get_transcript unless the question specifies otherwise.`;
  }

  const result = streamText({
    model: getAgentModel(),
    system,
    messages,
    tools: agentTools,
    maxSteps: 12,
  });

  return result.toDataStreamResponse();
}
