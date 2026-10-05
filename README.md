# ninjapa

NinjaPA — AI personal assistant Telegram bot

## Tech stack
TypeScript

## Run locally
```bash
git clone https://github.com/infosiva/ninjapa.git && cd ninjapa
npm install
cp .env.example .env.local   # names only, fill in your own values
npm run dev                    # http://localhost:3000
```

## Scripts
- `npm run dev`
- `npm run build`
- `npm run start`

## Environment variables
Names only; never commit real values. Everything is optional unless the feature needs it.

**AI providers (free-first chain; any one is enough):** `CEREBRAS_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`

- `ADMIN_USER_IDS`
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_DISABLED`
- `CEREBRAS_MODEL`
- `CLAUDE_MODEL`
- `FREE_TASKS_PER_DAY`
- `GEMINI_MODEL`
- `GOOGLE_PLACES_API_KEY`
- `GOOGLE_PLACES_DAILY_LIMIT`
- `GROQ_MODEL`
- `NVIDIA_API_KEY`
- `NVIDIA_MODEL`
- `OPENAI_MODEL`
- `PDF_OUTPUT_DIR`
- `SERPAPI_KEY`

## Deploy
Vercel (`vercel --prod`). Set the variables above in the project settings.

## Status & open items
See `HANDOFF.md` if present; otherwise open an issue.
