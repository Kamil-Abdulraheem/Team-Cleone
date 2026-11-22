import { NextResponse } from "next/server";
import { outreachFor } from "../../../lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { matchId } = (await req.json()) as { matchId?: number };
    if (!Number.isInteger(matchId)) {
      return NextResponse.json({ error: "matchId (integer) is required" }, { status: 400 });
    }
    return NextResponse.json({ email: await outreachFor(matchId as number) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unexpected error";
    return NextResponse.json({ error: msg }, { status: msg === "Match not found." ? 404 : 500 });
  }
}
