import { addFlightWatch, listFlightWatches, getAllActiveFlightWatches, updateFlightWatch } from '../db.js';

// ── Price checker — uses SerpAPI Google Flights if key available, else AI stub
async function checkFlightPrice(origin: string, destination: string, date?: string): Promise<number | null> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    console.log(`[flights] No SERPAPI_KEY — skipping live price check for ${origin}→${destination}`);
    return null;
  }

  try {
    const params = new URLSearchParams({
      engine: 'google_flights',
      departure_id: origin,
      arrival_id: destination,
      outbound_date: date ?? new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
      currency: 'GBP',
      hl: 'en',
      api_key: apiKey,
    });

    const res = await fetch(`https://serpapi.com/search?${params}`);
    if (!res.ok) return null;

    const data = await res.json() as any;
    const flights = data.best_flights ?? data.other_flights ?? [];
    if (flights.length === 0) return null;

    // Return cheapest price
    const prices = flights.map((f: any) => f.price).filter(Boolean);
    return prices.length > 0 ? Math.min(...prices) : null;
  } catch (e) {
    console.error('[flights] price check error:', e);
    return null;
  }
}

export async function tool_watch_flight(userId: number, args: {
  origin: string;         // e.g. "LHR" or "London Heathrow"
  destination: string;   // e.g. "MAA" or "Chennai"
  max_price: number;
  currency?: string;
  travel_date?: string;  // YYYY-MM-DD
}) {
  // Normalise to IATA-ish — real app would use an airport lookup
  const result = addFlightWatch(userId, {
    origin: args.origin.toUpperCase(),
    destination: args.destination.toUpperCase(),
    max_price: args.max_price,
    currency: args.currency ?? 'GBP',
    travel_date: args.travel_date,
  });

  return {
    success: true,
    watch_id: (result as any).lastInsertRowid,
    message: `Watching ${args.origin} → ${args.destination} — will alert you when price drops below ${args.currency ?? 'GBP'} ${args.max_price}.`,
    checks: 'Price checked once daily at 8 AM.',
  };
}

export async function tool_list_flight_watches(userId: number) {
  const watches = listFlightWatches(userId);
  if (watches.length === 0) return { watches: [], message: 'No active flight watches.' };
  return {
    watches: watches.map(w => ({
      id: w.id,
      route: `${w.origin} → ${w.destination}`,
      max_price: `${w.currency} ${w.max_price}`,
      last_price: w.last_price ? `${w.currency} ${w.last_price}` : 'Not checked yet',
      travel_date: w.travel_date,
      last_checked: w.last_checked,
    })),
  };
}

// Called daily by the scheduler
export async function checkAllFlightWatches(notify: (userId: number, message: string) => void) {
  const watches = getAllActiveFlightWatches();
  console.log(`[flights] Checking ${watches.length} active flight watches...`);

  for (const watch of watches) {
    const price = await checkFlightPrice(watch.origin, watch.destination, watch.travel_date);
    if (price === null) continue;

    updateFlightWatch(watch.id, price);

    if (price <= watch.max_price) {
      const msg = [
        `✈️ *Flight Alert!*`,
        `*${watch.origin} → ${watch.destination}*`,
        `Price dropped to *${watch.currency} ${price}* — under your limit of ${watch.currency} ${watch.max_price}`,
        watch.travel_date ? `Travel date: ${watch.travel_date}` : '',
        `\nBook now before it rises again! 🎯`,
      ].filter(Boolean).join('\n');

      notify(watch.user_id, msg);
    } else {
      console.log(`[flights] ${watch.origin}→${watch.destination}: £${price} (limit £${watch.max_price}) — not triggered`);
    }
  }
}
