import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = "gemini-3.8-flash";
const PROMPT = `You are an expert video editor, story analyst and YouTube growth strategist. Inspect the actual video and its audio. Do not invent events, dialogue, characters, visual details, duration, or claims. If something is unclear, say so. Return ONLY valid JSON with this exact shape:
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
Provide 3 distinct title options. Keep metadata faithful to the video. Timestamps must correspond to actual moments.`;

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Gemini is not configured yet. Add GEMINI_API_KEY to the Vercel project environment, then redeploy." }, { status: 503 });

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Sign in to analyze your videos." }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const videoId = typeof body.videoId === "string" ? body.videoId : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(videoId)) {
    return NextResponse.json({ error: "A valid video ID is required." }, { status: 400 });
  }

  const { data: video, error: videoError } = await supabase.from("videos")
    .select("id,user_id,original_filename,storage_path,mime_type,file_size_bytes,status")
    .eq("id", videoId).eq("user_id", user.id).single();
  if (videoError || !video || !video.storage_path) return NextResponse.json({ error: "Video not found in your private library." }, { status: 404 });
  if (!video.file_size_bytes || video.file_size_bytes > 50 * 1024 * 1024) return NextResponse.json({ error: "Video exceeds the current 50 MB storage limit." }, { status: 413 });

  const mimeType = video.mime_type === "video/quicktime" ? "video/mov" : video.mime_type;
  if (!["video/mp4", "video/mov", "video/webm"].includes(mimeType || "")) {
    return NextResponse.json({ error: "Gemini video analysis currently accepts MP4, MOV and WebM. Convert MKV to MP4 and upload it again." }, { status: 415 });
  }

  const { data: signed, error: signedError } = await supabase.storage.from("creator-videos").createSignedUrl(video.storage_path, 180);
  if (signedError || !signed?.signedUrl) return NextResponse.json({ error: "Could not securely access the stored video." }, { status: 500 });

  try {
    const source = await fetch(signed.signedUrl, { cache: "no-store" });
    if (!source.ok) throw new Error("Private video download failed.");
    const bytes = await source.arrayBuffer();
    if (bytes.byteLength !== video.file_size_bytes) throw new Error("Video size verification failed.");

    const init = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
        "X-Goog-Upload-Header-Content-Type": mimeType!,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ file: { display_name: video.original_filename.slice(0, 200) } })
    });
    if (!init.ok) throw new Error("Gemini file upload initialization failed: " + (await init.text()).slice(0, 400));
    const uploadUrl = init.headers.get("x-goog-upload-url");
    if (!uploadUrl) throw new Error("Gemini did not return a secure upload session.");

    const uploaded = await fetch(uploadUrl, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Length": String(bytes.byteLength), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
      body: bytes
    });
    if (!uploaded.ok) throw new Error("Gemini video upload failed: " + (await uploaded.text()).slice(0, 400));
    const fileResult = await uploaded.json();
    const file = fileResult.file ?? fileResult;
    if (!file.uri || !file.name) throw new Error("Gemini returned an incomplete video file reference.");

    const { error: upsertError } = await supabase.from("video_analysis").upsert({
      video_id: video.id, user_id: user.id, status: "processing",
      provider_file_name: file.name, provider_interaction_id: null,
      error_message: null, model_provider: "Google Gemini 3.8 Flash",
      transcript: null, scene_summary: [], story_summary: null, audience_signals: {}, safety_findings: []
    }, { onConflict: "video_id" });
    if (upsertError) throw new Error("Could not create the analysis record: " + upsertError.message);

    await supabase.from("videos").update({ status: "processing", updated_at: new Date().toISOString() }).eq("id", video.id).eq("user_id", user.id);
    return NextResponse.json({ ok: true, status: "processing", videoId, message: "Video uploaded to Gemini. Waiting for video processing to finish." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Video analysis failed.";
    await supabase.from("video_analysis").upsert({ video_id: video.id, user_id: user.id, status: "failed", error_message: message.slice(0, 1000), model_provider: "Google Gemini 3.8 Flash" }, { onConflict: "video_id" });
    await supabase.from("videos").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", video.id).eq("user_id", user.id);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
