import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    return NextResponse.json({
      ok: false,
      service: "ai-creator-studio",
      checks: { app: "ok", supabase: "missing_environment" },
      timestamp: new Date().toISOString()
    }, { status: 503 });
  }

  try {
    const response = await fetch(new URL("/rest/v1/", url), {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store"
    });
    return NextResponse.json({
      ok: response.ok,
      service: "ai-creator-studio",
      checks: {
        app: "ok",
        supabase: response.ok ? "reachable" : "unreachable"
      },
      timestamp: new Date().toISOString()
    }, { status: response.ok ? 200 : 503 });
  } catch {
    return NextResponse.json({
      ok: false,
      service: "ai-creator-studio",
      checks: { app: "ok", supabase: "unreachable" },
      timestamp: new Date().toISOString()
    }, { status: 503 });
  }
}