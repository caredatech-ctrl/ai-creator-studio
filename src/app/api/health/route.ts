import { NextResponse } from "next/server";
export async function GET() {
  return NextResponse.json({ ok: true, service: "ai-creator-studio", timestamp: new Date().toISOString() });
}