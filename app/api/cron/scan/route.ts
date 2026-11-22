import { NextResponse } from "next/server";
import { allProjectUrls, runScan } from "../../../../lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const results: { repo: string; ok: boolean; newlyScored?: number; error?: string }[] = [];
  for (const repo of allProjectUrls()) {
    try {
      const r = await runScan(repo);
      results.push({ repo, ok: true, newlyScored: r.scored });
    } catch (e) {
      results.push({ repo, ok: false, error: e instanceof Error ? e.message : "error" });
    }
  }
  return NextResponse.json({ rescanned: results });
}
