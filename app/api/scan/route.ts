import { NextResponse } from "next/server";
import { getProjectByUrl, listMatches, runScan } from "../../../lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const fail = (e: unknown, status = 500) =>
  NextResponse.json({ error: e instanceof Error ? e.message : "Unexpected error" }, { status });

export async function POST(req: Request) {
  try {
    const { repoUrl } = (await req.json()) as { repoUrl?: string };
    if (!repoUrl) return fail(new Error("repoUrl is required"), 400);
    return NextResponse.json(await runScan(repoUrl));
  } catch (e) {
    const bad = e instanceof Error && /GitHub repo|github\.com/i.test(e.message);
    return fail(e, bad ? 400 : 500);
  }
}

export async function GET(req: Request) {
  try {
    const repoUrl = new URL(req.url).searchParams.get("repoUrl");
    if (!repoUrl) return fail(new Error("repoUrl is required"), 400);
    const project = getProjectByUrl(repoUrl);
    if (!project) return fail(new Error("No scan found. POST to /api/scan first."), 404);
    return NextResponse.json(listMatches(project.id));
  } catch (e) {
    return fail(e, 400);
  }
}
