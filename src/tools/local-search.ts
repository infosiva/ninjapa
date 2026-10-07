/**
 * NinjaPA — Local trades & services search.
 *
 * Two modes — automatically switches based on quota:
 *   1. Google Places API — live results with ratings/reviews/phone
 *      - Only used if GOOGLE_PLACES_API_KEY is set
 *      - Daily hard limit: GOOGLE_PLACES_DAILY_LIMIT (default 40)
 *      - At 80% of limit → notifies admin
 *      - At 100% of limit → falls back to smart links, no charge
 *   2. Smart links fallback — Checkatrade, Google Maps, Trustpilot, MyBuilder
 *      Always works, zero cost, always available.
 *
 * UK-focused: Checkatrade is the most trusted vetted trades platform in the UK.
 */

import { getApiQuota, incrementApiQuota } from '../db.js';

const PLACES_API_BASE = 'https://maps.googleapis.com/maps/api/place';
const QUOTA_SERVICE   = 'google_places';

// Hard daily limit — stays well inside Google's free $200/month credit
// At $0.032/call, 40 calls/day = $1.28/day = ~$38/month — safe buffer under $200
const DAILY_LIMIT = parseInt(process.env.GOOGLE_PLACES_DAILY_LIMIT ?? '40');
const WARN_AT     = Math.floor(DAILY_LIMIT * 0.8); // warn admin at 80%

// ── Admin alert (fires once at 80% threshold) ────────────────────────────────
let warnedToday = false; // in-memory flag, resets on restart (fine — daily cycle)

export function checkPlacesQuotaAndNotify(notify?: (userId: number, msg: string) => void) {
  const used = getApiQuota(QUOTA_SERVICE);
  const adminIds = (process.env.ADMIN_USER_IDS ?? '').split(',').map(s => parseInt(s.trim())).filter(Boolean);

  if (!warnedToday && used >= WARN_AT && notify && adminIds.length > 0) {
    warnedToday = true;
    const msg =
      `⚠️ *Google Places quota alert*\n` +
      `Used *${used}/${DAILY_LIMIT}* calls today (80% of daily limit).\n` +
      `Remaining searches today will fall back to smart links automatically.\n` +
      `_Resets at midnight UTC._`;
    adminIds.forEach(id => notify(id, msg));
    console.log(`[places] Quota warning sent to admins: ${used}/${DAILY_LIMIT}`);
  }
}

// ── Google Places live search ─────────────────────────────────────────────────
async function searchGooglePlaces(
  query: string,
  location: string,
  notify?: (userId: number, msg: string) => void,
): Promise<any[] | null> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return null;

  // Check quota before making any call
  const used = getApiQuota(QUOTA_SERVICE);
  if (used >= DAILY_LIMIT) {
    console.log(`[places] Daily limit reached (${used}/${DAILY_LIMIT}) — using fallback`);
    return null;
  }

  try {
    const params = new URLSearchParams({
      query:    `${query} ${location}`,
      key:      apiKey,
      language: 'en-GB',
    });

    const res = await fetch(`${PLACES_API_BASE}/textsearch/json?${params}`);
    if (!res.ok) {
      console.warn('[places] API error:', res.status, res.statusText);
      return null;
    }

    const data = await res.json() as any;

    if (data.status === 'REQUEST_DENIED' || data.status === 'INVALID_REQUEST') {
      console.error('[places] API rejected:', data.status, data.error_message);
      return null;
    }

    if (data.status === 'ZERO_RESULTS') return [];

    if (data.status !== 'OK') {
      console.warn('[places] Unexpected status:', data.status);
      return null;
    }

    // Count the call only on success
    const newCount = incrementApiQuota(QUOTA_SERVICE);
    console.log(`[places] API call succeeded. Quota: ${newCount}/${DAILY_LIMIT}`);

    // Check if we should warn admin
    checkPlacesQuotaAndNotify(notify);

    return (data.results ?? []).slice(0, 5);
  } catch (e) {
    console.error('[places] fetch error:', e);
    return null;
  }
}

// ── Smart links fallback (always works, zero cost) ────────────────────────────
function buildSearchLinks(service: string, location: string): string {
  const q             = encodeURIComponent(`${service} ${location}`);
  const tradeSlug     = encodeURIComponent(service.toLowerCase().replace(/\s+/g, '-'));
  const locationSlug  = encodeURIComponent(location.toLowerCase());

  return [
    `🔧 [Checkatrade](https://www.checkatrade.com/search?search_term=${tradeSlug}&location=${locationSlug}) — UK's most trusted vetted trades`,
    `⭐ [Google Reviews](https://www.google.com/search?q=${q}+reviews) — ratings near you`,
    `🗺️ [Google Maps](https://www.google.com/maps/search/${q}) — map view + directions`,
    `📋 [Trustpilot](https://www.trustpilot.com/find-a-company?query=${q}) — company reviews`,
    `🏠 [MyBuilder](https://www.mybuilder.com/search#?location=${locationSlug}&trade=${tradeSlug}) — rated tradespeople`,
  ].join('\n');
}

// ── Format Google Places results ──────────────────────────────────────────────
function formatPlacesResult(results: any[], service: string, location: string): string {
  const top = results
    .filter(r => r.rating && r.user_ratings_total > 3)
    .sort((a, b) =>
      (b.rating * Math.log(b.user_ratings_total + 1)) -
      (a.rating * Math.log(a.user_ratings_total + 1))
    )
    .slice(0, 3);

  if (top.length === 0) {
    // Places returned results but none had enough reviews — use links
    return (
      `🔍 *${service} near ${location}*\n\n` +
      `No highly-rated results found on Google. Try these trusted directories:\n\n` +
      buildSearchLinks(service, location)
    );
  }

  let out = `📍 *Top ${service} near ${location}*\n\n`;

  top.forEach((r, i) => {
    const stars   = '⭐'.repeat(Math.round(r.rating));
    const reviews = r.user_ratings_total > 999
      ? `${(r.user_ratings_total / 1000).toFixed(1)}k reviews`
      : `${r.user_ratings_total} reviews`;

    out += `*${i + 1}. ${r.name}*\n`;
    out += `${stars} ${r.rating}/5 · ${reviews}\n`;
    if (r.formatted_address) out += `📍 ${r.formatted_address}\n`;
    if (r.formatted_phone_number) out += `📞 ${r.formatted_phone_number}\n`;
    if (r.website) out += `🌐 ${r.website}\n`;
    out += '\n';
  });

  out += `─────────────\n*More options:*\n`;
  out += buildSearchLinks(service, location);

  return out;
}

// ── Main tool ─────────────────────────────────────────────────────────────────
export async function tool_find_local_service(
  userId: number,
  args: { service: string; location: string },
  notify?: (userId: number, msg: string) => void,
) {
  const { service, location } = args;
  console.log(`[local-search] ${service} near ${location} (quota: ${getApiQuota(QUOTA_SERVICE)}/${DAILY_LIMIT})`);

  const places = await searchGooglePlaces(service, location, notify);

  if (places && places.length > 0) {
    return {
      success:  true,
      source:   'google_places',
      response: formatPlacesResult(places, service, location),
    };
  }

  // Fallback — either no key, quota hit, or zero results
  const reason = !process.env.GOOGLE_PLACES_API_KEY
    ? 'no key'
    : getApiQuota(QUOTA_SERVICE) >= DAILY_LIMIT
      ? 'quota reached'
      : 'no results';

  console.log(`[local-search] Using smart links fallback (${reason})`);

  return {
    success:  true,
    source:   'search_links',
    response:
      `🔍 *Finding ${service} near ${location}*\n\n` +
      `Here are the best places to find trusted, reviewed tradespeople:\n\n` +
      buildSearchLinks(service, location) +
      `\n\n💡 *Tip:* Checkatrade vets all trades for insurance and qualifications — safest choice.`,
  };
}
