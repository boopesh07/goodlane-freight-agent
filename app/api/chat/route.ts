import { streamText } from "ai";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { agentTools } from "@/lib/agent/tools";
import { assertDataFilesExist } from "@/lib/data/loaders";
import { getAgentModel } from "@/lib/model";

export const maxDuration = 60;

/**
 * Free-form Q&A agent (the "ask anything" surface). The structured intake
 * workflow is deterministic and lives in /api/intake; this route is the
 * exploratory agent that retrieves via the same typed tools and is instructed to
 * answer only from tool results.
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

  const body = (await req.json()) as {
    messages?: { role: "user" | "assistant"; content: string }[];
    asOf?: string;
  };

  const messages = body.messages ?? [];
  const asOf = body.asOf?.trim() || "2026-05-25T23:59:59Z";

  const system =
    SYSTEM_PROMPT +
    `\n\nThe broker is asking as of ${asOf}. Use this as before_timestamp when calling get_email_history, get_rate_history, and get_transcript unless the question specifies otherwise.`;

  const result = streamText({
    model: getAgentModel(),
    system,
    messages,
    tools: agentTools,
    maxSteps: 12,
  });

  return result.toDataStreamResponse();
}
