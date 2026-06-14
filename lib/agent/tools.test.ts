import { describe, expect, it } from "vitest";
import { agentTools } from "./tools";

// Tool execute() is optional in the SDK type and its params are a discriminated
// union; for tests we invoke it dynamically with plain objects.
function exec(name: keyof typeof agentTools): (args: any, opts: any) => Promise<any> {
  const fn = agentTools[name].execute as ((args: any, opts: any) => Promise<any>) | undefined;
  if (!fn) throw new Error(`${String(name)} has no execute`);
  return fn;
}

describe("draft_email tool", () => {
  it("quotes an approved rate and never marks itself as sent", async () => {
    const res: any = await exec("draft_email")(
      {
        to_email: "gene@crossroadstransport.net",
        to_name: "Crossroads Transport",
        load_id: "29372343",
        lane: "Reading, PA → Newark, NJ",
        purpose: "quote_rate",
        rate_usd: 850,
      },
      {} as any,
    );
    expect(res.status).toMatch(/not sent/i);
    expect(res.subject).toContain("850");
    expect(res.body).toContain("$850");
    expect(res.to).toBe("gene@crossroadstransport.net");
  });

  it("asks for confirmation instead of quoting on a low-confidence load", async () => {
    const res: any = await exec("draft_email")(
      { to_name: "Crossroads Transport", load_id: "29001373", purpose: "request_confirmation" },
      {} as any,
    );
    expect(res.subject.toLowerCase()).toContain("confirm");
    expect(res.body.toLowerCase()).toContain("confirm this is the correct load");
    expect(res.body).not.toContain("$");
  });
});

describe("get_load tool", () => {
  it("returns confidence + human-verification flag on a relaxed structured match", async () => {
    const res: any = await exec("get_load")(
      {
        origin_state: "PA",
        destination_state: "MD",
        equipment_type: "Box Truck",
        offered_rate: 440,
        status: "open",
      },
      {} as any,
    );
    expect(res.matched_by).toBe("structured_search");
    expect(res.needs_human_verification).toBe(true);
    expect(res.top_confidence).toBeLessThan(0.85);
    expect(res.loads[0]).toHaveProperty("confidence_pct");
  });
});
