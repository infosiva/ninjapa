
## Design lock (2026-10-05)
- Project: NinjaPA | Archetype: marketing-calendar (pickArchetype, avoid list applied)
- bg #fff7ed / accent #c2410c (registered in design-system/tokens/palette-registry.json, check-palettes: 0 collisions)
- Logo: ember starburst tile, Ninja+PA wordmark (icon.svg + apple-icon.png)
- Static public/index.html; fake bubbles, fake 4-plan pricing price GBP7.99 and (c)2025 removed; Pro marked planned; no chat/feedback routes (Telegram bot, feedback via bot)
- Status: design applied, build/screens checked; GA4 off (no ID set); theme-loader copied to lib/theme-loader.ts (not wired: no Next layout.tsx here)

## Runtime-switch + telemetry retrofit (2026-10-06) - files only, nothing committed
- public/index.html: same hub-theme block (SITE=ninjapa, no GA id unless hub supplies one). api/usage.js (ESM, 204, JSON log; node --check ok). Backup: public/index.html.bak.
- Not verified: Vercel deploy of api/usage, hub CORS/response shape, screenshots.


## ANIMATED SCOPE (recorded 2026-10-09 sweep)
- What moves: CSS keyframes already shipped: drift, hbf, hbs, pop, rise.
- Why: ambient background + entry/press feedback on the product's core action; no motion carries information alone.
- Trigger: page load (ambient/entry), user press/hover (feedback).
- Reduced-motion: `prefers-reduced-motion` handling present in the project's styles (verified by scan 2026-10-09).
- Still open: `/review-animations` run (needs a running app, one at a time).

## Gate gaps closed 2026-10-09
- Stack verified: static public/index.html + Telegram bot (src/bot.ts, no /feedback command, no HTTP chat route). The 2026-10-05 line "no chat/feedback routes" is a design note, not an explicit gate exemption, so feedback was added.
- 404: public/404.html (brand tokens, 44px home link, reduced-motion). Verified 375 + 1280 by click to "/".
- Feedback: floating widget in public/index.html, posts {message,email?,page,site:"ninjapa"} to hub /api/feedback with no-cors; UI says "delivery unconfirmed". Payload read back with the endpoint stubbed (page.route). Sits above the consent banner (body:has(#hb-c)).
- Chatbot: OWNER-BLOCKED. No chat route exists; the Telegram bot is the product's chat. Owner decides: embed a web chatbot (would need a server route + ai-core), or accept the bot as the exemption.
- Promo: ASSUMPTION for owner to confirm: Pro is "planned, no price, nothing purchasable", so no promo/trial code system was built. Needed when Pro ships.
- Not tested: live Vercel deploy (404.html serving, real hub receipt of feedback), /review-animations, screen reader.
