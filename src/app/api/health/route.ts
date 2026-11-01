import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function timed<T>(task: () => Promise<T>, ms = 8000): Promise<T> {
  return await Promise.race([task(), new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Health check timed out")), ms))]);
}

export async function GET() {
  const checkedAt = new Date().toISOString();
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const services: Record<string, any> = {};
  const dbStarted = Date.now();
  try {
    const { error } = await timed(() => supabase.from("videos").select("id", { count: "exact", head: true }).eq("user_id", user.id));
    if (error) throw error;
    services.database = { status: "online", latencyMs: Date.now() - dbStarted };
  } catch (error) {
    services.database = { status: "error", message: error instanceof Error ? error.message : "Database check failed." };
  }

  const storageStarted = Date.now();
  try {
    const { error } = await timed(() => supabase.storage.from("creator-videos").list(user.id, { limit: 1 }));
    if (error) throw error;
    services.storage = { status: "online", latencyMs: Date.now() - storageStarted, bucket: "creator-videos" };
  } catch (error) {
    services.storage = { status: "error", message: error instanceof Error ? error.message : "Storage check failed." };
  }

  const geminiStarted = Date.now();
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) services.gemini = { status: "not_configured", model: "gemini-3.8-flash" };
  else {
    try {
      const response = await timed(() => fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash", { headers: { "x-goog-api-key": geminiKey }, cache: "no-store" }));
      if (!response.ok) throw new Error("Gemini API returned HTTP " + response.status + (await response.text()).slice(0, 180));
      services.gemini = { status: "online", model: "gemini-3.8-flash", latencyMs: Date.now() - geminiStarted };
    } catch (error) {
      services.gemini = { status: "error", model: "gemini-3.8-flash", message: error instanceof Error ? error.message : "Gemini health check failed." };
    }
  }

  const deploymentStarted = Date.now();
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID || process.env.PROJECT_ID;
  if (token && projectId) {
    try {
      const params = new URLSearchParams({ projectId, limit: "1", target: "production" });
      if (process.env.VERCEL_TEAM_ID) params.set("teamId", process.env.VERCEL_TEAM_ID);
      const response = await timed(() => fetch("https://api.vercel.com/v6/deployments?" + params.toString(), { headers: { Authorization: "Bearer " + token }, cache: "no-store" }));
      if (!response.ok) throw new Error("Vercel API returned HTTP " + response.status);
      const payload = await response.json();
      const latest = payload.deployments?.[0];
      services.deployments = latest ? { status: String(latest.readyState || latest.state || "unknown").toLowerCase(), url: latest.url ? "https://" + latest.url : null, createdAt: latest.created ? new Date(latest.created).toISOString() : null, commit: latest.meta?.githubCommitSha || null, latencyMs: Date.now() - deploymentStarted } : { status: "unknown", message: "No production deployment was returned." };
    } catch (error) {
      services.deployments = { status: "error", message: error instanceof Error ? error.message : "Deployment status check failed." };
    }
  } else {
    services.deployments = { status: "current_instance_online", environment: process.env.VERCEL_ENV || "unknown", url: process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : null, commit: process.env.VERCEL_GIT_COMMIT_SHA || null, message: "Live deployment feed requires VERCEL_TOKEN and VERCEL_PROJECT_ID." };
  }

  const statuses = Object.values(services).map((item: any) => item.status);
  const overall = statuses.includes("error") ? "degraded" : statuses.includes("not_configured") ? "attention" : "online";
  return NextResponse.json({ ok: overall === "online", overall, checkedAt, services, app: { status: "online", environment: process.env.VERCEL_ENV || "development", region: process.env.VERCEL_REGION || "unknown", commit: process.env.VERCEL_GIT_COMMIT_SHA || null } }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
