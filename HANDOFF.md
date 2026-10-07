
## Design lock (2026-10-05)
- Project: NinjaPA | Archetype: marketing-calendar (pickArchetype, avoid list applied)
- bg #fff7ed / accent #c2410c (registered in design-system/tokens/palette-registry.json, check-palettes: 0 collisions)
- Logo: ember starburst tile, Ninja+PA wordmark (icon.svg + apple-icon.png)
- Static public/index.html; fake bubbles, fake 4-plan pricing price GBP7.99 and (c)2025 removed; Pro marked planned; no chat/feedback routes (Telegram bot, feedback via bot)
- Status: design applied, build/screens checked; GA4 off (no ID set); theme-loader copied to lib/theme-loader.ts (not wired: no Next layout.tsx here)

## Runtime-switch + telemetry retrofit (2026-10-06) - files only, nothing committed
- public/index.html: same hub-theme block (SITE=ninjapa, no GA id unless hub supplies one). api/usage.js (ESM, 204, JSON log; node --check ok). Backup: public/index.html.bak.
- Not verified: Vercel deploy of api/usage, hub CORS/response shape, screenshots.
