import { NextResponse } from "next/server";
import { recordFeedback } from "../../../lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const b = (await req.json()) as { matchId?: number; action?: string; reason?: string };
    if (!Number.isInteger(b.matchId) || (b.action !== "like" && b.action !== "dismiss")) {
      return NextResponse.json(
        { error: "matchId (integer) and action ('like' | 'dismiss') are required" },
        { status: 400 }
      );
    }
    recordFeedback(b.matchId as number, b.action, b.reason?.slice(0, 200));
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unexpected error";
    return NextResponse.json({ error: msg }, { status: msg === "Match not found." ? 404 : 500 });
  }
}
