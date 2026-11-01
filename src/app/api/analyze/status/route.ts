import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 30;

function extractJson(raw: string) {
  const cleaned = raw.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Gemini returned no valid structured analysis.");
  return JSON.parse(cleaned.slice(start, end + 1));
}

export async function GET(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Gemini API key is not configured." }, { status: 503 });
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const videoId = new URL(request.url).searchParams.get("videoId") || "";
  const { data: analysis, error } = await supabase.from("video_analysis")
    .select("*").eq("video_id", videoId).eq("user_id", user.id).single();
  if (error || !analysis) return NextResponse.json({ error: "Analysis not found." }, { status: 404 });
  if (analysis.status === "completed") {
    const { data: metadata } = await supabase.from("generated_metadata").select("*")
      .eq("video_id", videoId).eq("user_id", user.id).order("created_at", { ascending: false }).limit(3);
    return NextResponse.json({ ok: true, status: "completed", analysis, metadata: metadata ?? [] });
  }
  if (analysis.status === "failed") return NextResponse.json({ ok: false, status: "failed", error: analysis.error_message || "Analysis failed." });
  if (!analysis.provider_interaction_id) {
    if (!analysis.provider_file_name) return NextResponse.json({ ok: true, status: analysis.status, message: "Preparing video analysis." });
    try {
      const fileResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/" + analysis.provider_file_name, {
        headers: { "x-goog-api-key": apiKey }, cache: "no-store"
      });
      if (!fileResponse.ok) throw new Error("Could not check Gemini video processing: " + (await fileResponse.text()).slice(0, 300));
      const file = await fileResponse.json();
      const fileState = String(file.state || "").toUpperCase();
      if (fileState === "PROCESSING") return NextResponse.json({ ok: true, status: "processing", message: "Gemini is preparing the video for analysis." });
      if (fileState !== "ACTIVE") throw new Error(file.error?.message || "Gemini could not process this video file.");
      const interactionResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gemini-3.8-flash", background: true,
          input: [
            { type: "video", uri: file.uri, mime_type: file.mimeType || file.mime_type, processing: "agentic" },
            { type: "text", text: `You are an expert video editor, story analyst and YouTube growth strategist. Inspect the actual video and its audio. Do not invent events, dialogue, characters, visual details, duration, or claims. If something is unclear, say so. Return ONLY valid JSON with this exact shape:
{
 "story_summary":"Concise factual summary of what actually happens",
 "hook":"What happens in the opening and how compelling it is",
 "scenes":[{"timestamp":"00:00","description":"Visible scene/action","purpose":"Narrative or editing purpose"}],
 "characters_and_objects":[{"name":"Only if identifiable from video","description":"Observable traits or role"}],
 "audio_and_transcript":{"transcript":"Verbatim only when clearly audible; otherwise empty string","audio_summary":"Speech, music, sound effects and audio quality"},
 "audience_signals":{"likely_audience":"Evidence-based audience","topic":"Main topic","tone":"Tone","emotions":["observed emotions"],"format":"Short/long/educational/story/etc"},
 "quality_review":{"strengths":["specific observed strengths"],"improvements":["actionable edits"],"policy_flags":["Only concrete potential YouTube policy concerns; otherwise empty"]},
 "youtube_metadata":[{"title":"Accurate compelling title","description":"Accurate description, no fabricated claims","tags":["relevant tags"],"hashtags":["relevant hashtags"],"rationale":"Why this fits the actual video"}],
 "thumbnail_ideas":[{"concept":"Visual composition grounded in actual footage","text":"Short overlay text"}]
}
Provide 3 distinct title options. Keep metadata faithful to the video. Timestamps must correspond to actual moments.` }
          ]
        })
      });
      if (!interactionResponse.ok) throw new Error("Gemini analysis could not start: " + (await interactionResponse.text()).slice(0, 500));
      const interaction = await interactionResponse.json();
      if (!interaction.id) throw new Error("Gemini did not return an analysis job ID.");
      const { error: updateError } = await supabase.from("video_analysis").update({
        provider_interaction_id: interaction.id, status: "processing", updated_at: new Date().toISOString()
      }).eq("id", analysis.id).eq("user_id", user.id);
      if (updateError) throw new Error("Could not save Gemini analysis job: " + updateError.message);
      return NextResponse.json({ ok: true, status: "processing", message: "Gemini is now analyzing the actual video and audio." });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not start Gemini analysis.";
      await supabase.from("video_analysis").update({ status: "failed", error_message: message.slice(0, 1000), updated_at: new Date().toISOString() }).eq("id", analysis.id);
      await supabase.from("videos").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", videoId).eq("user_id", user.id);
      return NextResponse.json({ ok: false, status: "failed", error: message }, { status: 502 });
    }
  }

  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions/" + encodeURIComponent(analysis.provider_interaction_id), {
      headers: { "x-goog-api-key": apiKey }, cache: "no-store"
    });
    if (!response.ok) throw new Error("Could not retrieve Gemini job status: " + (await response.text()).slice(0, 300));
    const job = await response.json();
    const state = String(job.status || job.state || "in_progress").toLowerCase();
    if (["failed", "cancelled", "canceled"].includes(state)) {
      const message = job.error?.message || "Gemini could not complete this video analysis.";
      await supabase.from("video_analysis").update({ status: "failed", error_message: message, updated_at: new Date().toISOString() }).eq("id", analysis.id);
      await supabase.from("videos").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", videoId).eq("user_id", user.id);
      return NextResponse.json({ ok: false, status: "failed", error: message });
    }
    if (state !== "completed" && state !== "succeeded") return NextResponse.json({ ok: true, status: "processing", message: "Gemini is still analyzing the video." });

    const raw = job.output_text || job.output?.text || (Array.isArray(job.steps) ? job.steps.flatMap((s: any) => s.content || []).map((c: any) => c.text || "").join("\n") : "");
    const result = extractJson(String(raw));
    const { error: saveAnalysisError } = await supabase.from("video_analysis").update({
      status: "completed", transcript: result.audio_and_transcript?.transcript || "",
      scene_summary: result.scenes || [], story_summary: result.story_summary || "",
      audience_signals: result.audience_signals || {},
      safety_findings: result.quality_review?.policy_flags || [],
      error_message: null, updated_at: new Date().toISOString()
    }).eq("id", analysis.id).eq("user_id", user.id);
    if (saveAnalysisError) throw new Error("Could not save analysis: " + saveAnalysisError.message);

    const options = Array.isArray(result.youtube_metadata) ? result.youtube_metadata.slice(0, 3) : [];
    if (options.length) {
      await supabase.from("generated_metadata").delete().eq("video_id", videoId).eq("user_id", user.id).eq("is_selected", false);
      const { error: metadataError } = await supabase.from("generated_metadata").insert(options.map((item: any) => ({
        video_id: videoId, user_id: user.id, title: String(item.title || "").slice(0, 100),
        description: String(item.description || "").slice(0, 5000),
        tags: Array.isArray(item.tags) ? item.tags.slice(0, 30).map(String) : [],
        hashtags: Array.isArray(item.hashtags) ? item.hashtags.slice(0, 15).map(String) : [],
        rationale: { reason: String(item.rationale || ""), thumbnail_ideas: result.thumbnail_ideas || [], quality_review: result.quality_review || {} }
      })));
      if (metadataError) throw new Error("Analysis saved but metadata save failed: " + metadataError.message);
    }
    await supabase.from("videos").update({ status: "ready_for_review", updated_at: new Date().toISOString() }).eq("id", videoId).eq("user_id", user.id);
    return NextResponse.json({ ok: true, status: "completed", analysis: { ...analysis, ...result, status: "completed" }, metadata: options });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not parse Gemini analysis.";
    await supabase.from("video_analysis").update({ status: "failed", error_message: message.slice(0, 1000), updated_at: new Date().toISOString() }).eq("id", analysis.id);
    await supabase.from("videos").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", videoId).eq("user_id", user.id);
    return NextResponse.json({ ok: false, status: "failed", error: message }, { status: 502 });
  }
}
