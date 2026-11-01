# AI Creator Studio

AI-powered video intelligence and YouTube publishing workspace.

## Stack
- Next.js + TypeScript, deployed on Vercel
- Supabase Auth, Postgres, and Storage
- Official YouTube Data API OAuth and resumable uploads
- Media analysis worker planned with FFmpeg, PySceneDetect, and Faster-Whisper

## Safety
Publishing must require explicit user approval. Never collect Google passwords or use unofficial upload automation.

## Local development
1. Copy `.env.example` to `.env.local`.
2. Add Supabase and provider credentials.
3. Run `npm install` and `npm run dev`.
