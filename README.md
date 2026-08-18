# Research Radar

Personal research system for photographer Yun Taejun — collects materials into a Research Reservoir, detects interest shifts, and distills research directions. NOT a chatbot; a research editor.

Spec: `docs/spec-v0.1.txt` (original) · `docs/SPEC.md` (v1.0 decisions) · `docs/DEV_PLAN.md`

## Architecture

- `worker/` — Cloudflare Worker (Hono): API + weekly cron (snapshot + discovery)
- `web/` — Vite + React SPA (served via Workers Static Assets)
- Storage: D1 (metadata, 18 tables) · R2 (originals + exports) · Workers AI (analysis) · AI Gateway → OpenAI (Distill/Critic/Counter/Radar)
- Auth: Cloudflare Access (single user), JWT verified in-worker
- Live: https://radar.taejunyun.com

## Commands

```bash
pnpm i            # install
pnpm dev          # local dev (worker :8787 + web vite proxy)
pnpm deploy       # build web + deploy worker
pnpm db:migrate   # apply D1 migrations (remote)
pnpm typecheck    # tsc across packages
```

Secrets (`wrangler secret put`): `OPENAI_API_KEY`, `CF_AIG_TOKEN` (AI Gateway auth token).

## Flow

Ingest (note/URL/md/PDF/homepage) → R2 original preservation → dedup chain (DOI→URL→title+author→hash) → Workers AI analysis (classification/summary/keywords/questions/fragments) → Reservoir → Distill (OpenAI, context-selected) → Critic + Counter (auto) → Reading Queue (OpenAlex-verified) → Research Gaps → user signals (keep/watch/develop/ignore) → weekly Radar snapshots + synthesis (W/M/Y) → Discovery (OpenAlex, weekly, max 20/run).

Budget guardrail: $10/month (ai_usage ledger, 80% warn / 100% block Distill).
