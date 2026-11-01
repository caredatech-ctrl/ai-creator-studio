import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    story_summary: { type: "string" }, hook: { type: "string" },
    scenes: { type: "array", items: { type: "object", properties: { timestamp: { type: "string" }, description: { type: "string" }, purpose: { type: "string" } }, required: ["timestamp", "description", "purpose"] } },
    characters_and_objects: { type: "array", items: { type: "object", properties: { name: { type: "string" }, description: { type: "string" } }, required: ["name", "description"] } },
    audio_and_transcript: { type: "object", properties: { transcript: { type: "string" }, audio_summary: { type: "string" } }, required: ["transcript", "audio_summary"] },
    audience_signals: { type: "object", properties: { likely_audience: { type: "string" }, topic: { type: "string" }, tone: { type: "string" }, emotions: { type: "array", items: { type: "string" } }, format: { type: "string" } }, required: ["likely_audience", "topic", "tone", "emotions", "format"] },
    quality_review: { type: "object", properties: { strengths: { type: "array", items: { type: "string" } }, improvements: { type: "array", items: { type: "string" } }, policy_flags: { type: "array", items: { type: "string" } } }, required: ["strengths", "improvements", "policy_flags"] },
    youtube_metadata: { type: "array", minItems: 3, maxItems: 3, items: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, tags: { type: "array", items: { type: "string" } }, hashtags: { type: "array", items: { type: "string" } }, rationale: { type: "string" } }, required: ["title", "description", "tags", "hashtags", "rationale"] } },
    thumbnail_ideas: { type: "array", items: { type: "object", properties: { concept: { type: "string" }, text: { type: "string" } }, required: ["concept", "text"] } }
  },
  required: ["story_summary", "hook", "scenes", "characters_and_objects", "audio_and_transcript", "audience_signals", "quality_review", "youtube_metadata", "thumbnail_ideas"]
};

function extractJson(raw: string) {
  const cleaned = raw.trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/, "");
  const start = cleaned.indexOf("{");
  if (start < 0) throw new Error("Gemini completed without returning the required JSON object. Retry analysis; no guessed content was saved.");
  let depth = 0, quoted = false, escaped = false, end = -1;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (quoted) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') quoted = false; continue; }
    if (ch === '"') quoted = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) { end = i; break; }
  }
  if (end < 0) throw new Error("Gemini returned incomplete JSON. The result was not saved; retry analysis.");
  let value: any;
  try { value = JSON.parse(cleaned.slice(start, end + 1)); }
  catch { throw new Error("Gemini returned malformed JSON despite structured-output mode. The result was not saved; retry analysis."); }
  const isStringArray = (items: any) => Array.isArray(items) && items.every((item: any) => typeof item === "string");
  const validScenes = Array.isArray(value?.scenes) && value.scenes.every((scene: any) => scene && typeof scene.timestamp === "string" && typeof scene.description === "string" && typeof scene.purpose === "string");
  const validMetadata = Array.isArray(value?.youtube_metadata) && value.youtube_metadata.length === 3 && value.youtube_metadata.every((item: any) => item && typeof item.title === "string" && typeof item.description === "string" && typeof item.rationale === "string" && isStringArray(item.tags) && isStringArray(item.hashtags));
  const validAudio = value?.audio_and_transcript && typeof value.audio_and_transcript.transcript === "string" && typeof value.audio_and_transcript.audio_summary === "string";
  const validAudience = value?.audience_signals && typeof value.audience_signals.likely_audience === "string" && typeof value.audience_signals.topic === "string" && typeof value.audience_signals.tone === "string" && typeof value.audience_signals.format === "string" && isStringArray(value.audience_signals.emotions);
  const validQuality = value?.quality_review && isStringArray(value.quality_review.strengths) && isStringArray(value.quality_review.improvements) && isStringArray(value.quality_review.policy_flags);
  const validPeople = Array.isArray(value?.characters_and_objects) && value.characters_and_objects.every((item: any) => item && typeof item.name === "string" && typeof item.description === "string");
  const validThumbnails = Array.isArray(value?.thumbnail_ideas) && value.thumbnail_ideas.every((item: any) => item && typeof item.concept === "string" && typeof item.text === "string");
  if (!value || typeof value !== "object" || typeof value.story_summary !== "string" || typeof value.hook !== "string" || !validScenes || !validMetadata || !validAudio || !validAudience || !validQuality || !validPeople || !validThumbnails) {
    throw new Error("Gemini output did not match the complete video-analysis schema. Nothing was saved; retry analysis.");
  }
  return value;
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
      if (fileState === "PROCESSING") return NextResponse.json({ ok: true, status: "processing", stage: "Preparing video and audio", message: "Gemini is processing the uploaded video before starting scene and audio analysis.", providerState: fileState, checkedAt: new Date().toISOString() });
      if (fileState !== "ACTIVE") throw new Error(file.error?.message || "Gemini could not process this video file.");
      const { data: videoInfo } = await supabase.from("videos").select("file_size_bytes").eq("id", videoId).eq("user_id", user.id).maybeSingle();
      // Short clips use static sampling; larger uploads use agentic analysis for deeper inspection.
      const processingMode = Number(videoInfo?.file_size_bytes || 0) > 8 * 1024 * 1024 ? "agentic" : "static";
      const interactionResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gemini-3.8-flash", background: true, generation_config: { max_output_tokens: 8192 },
          response_format: { type: "text", mime_type: "application/json", schema: ANALYSIS_SCHEMA },
          input: [
            { type: "video", uri: file.uri, mime_type: file.mimeType || file.mime_type, processing: processingMode },
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
      return NextResponse.json({ ok: true, status: "processing", stage: "Analyzing video and audio", message: "Gemini has accepted the analysis job and is examining the actual footage, scenes, speech and sound.", providerState: String(interaction.status || "in_progress"), checkedAt: new Date().toISOString() });
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
    const terminalFailures = ["failed", "cancelled", "canceled", "incomplete", "budget_exceeded", "requires_continuation", "requires_action"];
    let fallbackRaw = "";
    if (terminalFailures.includes(state)) {
      const providerError = typeof job.error === "string" ? job.error : job.error?.message || job.error?.details || job.error?.code || "";
      const stepErrors = Array.isArray(job.steps) ? job.steps
        .filter((step: any) => step?.error || step?.type === "error")
        .map((step: any) => typeof step.error === "string" ? step.error : step.error?.message || step.message || "")
        .filter(Boolean).join(" | ") : "";
      let fallbackFailure = "";
      if (["failed", "incomplete", "budget_exceeded"].includes(state) && analysis.provider_file_name) {
        try {
          const fileResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/" + analysis.provider_file_name, {
            headers: { "x-goog-api-key": apiKey }, cache: "no-store"
          });
          if (!fileResponse.ok) throw new Error("Could not retrieve the uploaded Gemini video file (HTTP " + fileResponse.status + ").");
          const file = await fileResponse.json();
          if (String(file.state || "").toUpperCase() !== "ACTIVE" || !file.uri) throw new Error("The uploaded Gemini file is not ACTIVE and cannot be used for fallback analysis.");
          const fallbackPrompt = `You are an expert video editor, story analyst and YouTube growth strategist. Inspect the actual video and its audio. Do not invent events, dialogue, characters, visual details, duration, or claims. If something is unclear, say so. Return ONLY valid JSON with this exact shape:
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
Provide exactly 3 distinct title options. Keep metadata faithful to the video. Timestamps must correspond to actual moments. If a scene, speaker, or word cannot be verified from the media, explicitly say so rather than guessing.`;
          const fallbackResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent", {
            method: "POST",
            headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({
              contents: [{ parts: [
                { fileData: { mimeType: file.mimeType || file.mime_type || "video/mp4", fileUri: file.uri } },
                { text: fallbackPrompt }
              ] }],
              generationConfig: { responseMimeType: "application/json", responseJsonSchema: ANALYSIS_SCHEMA, maxOutputTokens: 8192 }
            })
          });
          if (!fallbackResponse.ok) throw new Error("Direct video fallback returned HTTP " + fallbackResponse.status + ": " + (await fallbackResponse.text()).slice(0, 700));
          const fallbackJson = await fallbackResponse.json();
          fallbackRaw = (fallbackJson.candidates || []).flatMap((candidate: any) => candidate.content?.parts || []).map((part: any) => part.text || "").filter(Boolean).join("\\n");
          if (!fallbackRaw) throw new Error("Direct video fallback completed without a text result. Finish reason: " + String(fallbackJson.candidates?.[0]?.finishReason || "unknown"));
          extractJson(fallbackRaw);
        } catch (fallbackError) {
          fallbackFailure = fallbackError instanceof Error ? fallbackError.message : "Direct video fallback failed.";
        }
      }
      if (!fallbackRaw) {
        const safeProviderDetail = String(providerError || stepErrors || fallbackFailure || "").trim();
        const message = ("Gemini background analysis ended with status " + state + ". " +
          (safeProviderDetail ? "Provider detail: " + safeProviderDetail : "Gemini did not return a provider error detail.") +
          (fallbackFailure ? " Direct video fallback: " + fallbackFailure : " No fallback was run for this provider status.") +
          " The original prompt is not an error message; retry starts a fresh analysis.").slice(0, 1000);
        await supabase.from("video_analysis").update({ status: "failed", error_message: message, updated_at: new Date().toISOString() }).eq("id", analysis.id).eq("user_id", user.id);
        await supabase.from("videos").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", videoId).eq("user_id", user.id);
        return NextResponse.json({ ok: false, status: "failed", error: message, providerState: state, canRetry: true });
      }
    }
    if (state !== "completed" && state !== "succeeded") return NextResponse.json({ ok: true, status: "processing", stage: state === "queued" ? "Waiting for Gemini capacity" : "Analyzing video and audio", message: state === "queued" ? "Gemini has queued your analysis. The app will keep checking automatically." : "Gemini is still analyzing the actual footage and audio. The job remains active; the next check will update this window.", providerState: state, checkedAt: new Date().toISOString() });

    const raw = fallbackRaw || job.output_text || job.output?.text || (Array.isArray(job.outputs) ? job.outputs.map((o: any) => o.text || o.content?.map?.((p: any) => p.text || "").join("") || "").join("\n") : "") || (Array.isArray(job.steps) ? job.steps.filter((step: any) => step.type === "model_output").flatMap((s: any) => s.content || []).map((part: any) => part.text || "").filter(Boolean).join("\n") : "");
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
    return NextResponse.json({ ok: true, status: "completed", stage: "Analysis complete", message: "Gemini finished the analysis and the results were saved securely.", checkedAt: new Date().toISOString(), analysis: { ...analysis, ...result, status: "completed" }, metadata: options });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not parse Gemini analysis.";
    await supabase.from("video_analysis").update({ status: "failed", error_message: message.slice(0, 1000), updated_at: new Date().toISOString() }).eq("id", analysis.id);
    await supabase.from("videos").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", videoId).eq("user_id", user.id);
    return NextResponse.json({ ok: false, status: "failed", error: message }, { status: 502 });
  }
}
