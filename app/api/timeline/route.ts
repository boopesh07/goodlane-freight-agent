import { assertDataFilesExist } from "@/lib/data/loaders";
import { buildTimelineChartData } from "@/lib/ingestion/context";

export async function GET() {
  try {
    assertDataFilesExist();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Data files missing";
    return Response.json({ error: message }, { status: 500 });
  }

  const chart = buildTimelineChartData();
  return Response.json(chart);
}
