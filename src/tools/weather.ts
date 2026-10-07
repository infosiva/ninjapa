/**
 * NinjaPA — Weather tool via Open-Meteo (free, no API key needed).
 *
 * Flow:
 *   1. Geocode the location name → lat/lon via Open-Meteo geocoding API
 *   2. Fetch current conditions + today's forecast
 *   3. Return a formatted Telegram-markdown string
 */

const GEO_API   = 'https://geocoding-api.open-meteo.com/v1/search';
const METEO_API = 'https://api.open-meteo.com/v1/forecast';

// WMO weather code → readable description
const WMO: Record<number, string> = {
  0: 'Clear sky ☀️', 1: 'Mainly clear 🌤️', 2: 'Partly cloudy ⛅', 3: 'Overcast ☁️',
  45: 'Foggy 🌫️', 48: 'Icy fog 🌫️',
  51: 'Light drizzle 🌦️', 53: 'Drizzle 🌦️', 55: 'Heavy drizzle 🌧️',
  61: 'Light rain 🌧️', 63: 'Rain 🌧️', 65: 'Heavy rain 🌧️',
  71: 'Light snow 🌨️', 73: 'Snow 🌨️', 75: 'Heavy snow ❄️',
  80: 'Light showers 🌦️', 81: 'Showers 🌦️', 82: 'Heavy showers ⛈️',
  95: 'Thunderstorm ⛈️', 96: 'Thunderstorm with hail ⛈️', 99: 'Severe thunderstorm ⛈️',
};

function wmoDesc(code: number): string {
  return WMO[code] ?? `Code ${code}`;
}

async function geocode(location: string): Promise<{ name: string; lat: number; lon: number; country: string } | null> {
  const url = `${GEO_API}?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json() as any;
  const r = data.results?.[0];
  if (!r) return null;
  return { name: r.name, lat: r.latitude, lon: r.longitude, country: r.country ?? '' };
}

export async function tool_get_weather(
  _userId: number,
  args: { location: string; timezone?: string },
): Promise<{ success: boolean; response?: string; error?: string }> {
  const { location, timezone } = args;

  const geo = await geocode(location);
  if (!geo) {
    return { success: false, error: `Could not find "${location}" — try a city name.` };
  }

  const tz = timezone ?? 'Europe/London';
  const params = new URLSearchParams({
    latitude:              String(geo.lat),
    longitude:             String(geo.lon),
    current:               'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code',
    daily:                 'temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code',
    timezone:              tz,
    forecast_days:         '3',
  });

  const res = await fetch(`${METEO_API}?${params}`);
  if (!res.ok) return { success: false, error: 'Weather API error — try again shortly.' };

  const d = await res.json() as any;
  const c = d.current;
  const daily = d.daily;

  const condition = wmoDesc(c.weather_code);
  const temp      = Math.round(c.temperature_2m);
  const feels     = Math.round(c.apparent_temperature);
  const humidity  = c.relative_humidity_2m;
  const wind      = Math.round(c.wind_speed_10m);

  let msg = `🌤️ *Weather in ${geo.name}, ${geo.country}*\n\n`;
  msg += `${condition}\n`;
  msg += `🌡️ *${temp}°C* · feels like ${feels}°C\n`;
  msg += `💧 Humidity: ${humidity}%  💨 Wind: ${wind} km/h\n\n`;

  // 3-day forecast
  msg += `📅 *3-day forecast*\n`;
  const days = ['Today', 'Tomorrow', 'Day after'];
  for (let i = 0; i < 3; i++) {
    const date  = new Date(daily.time[i]).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const hi    = Math.round(daily.temperature_2m_max[i]);
    const lo    = Math.round(daily.temperature_2m_min[i]);
    const rain  = daily.precipitation_sum[i];
    const desc  = wmoDesc(daily.weather_code[i]);
    const label = i < 2 ? days[i] : date;
    msg += `  *${label}:* ${desc} · ${lo}–${hi}°C`;
    if (rain > 0) msg += ` · 🌧️ ${rain}mm`;
    msg += '\n';
  }

  return { success: true, response: msg };
}

/**
 * Lightweight version for digest — returns a single-line weather summary.
 */
export async function getWeatherSummary(location: string, timezone: string): Promise<string | null> {
  try {
    const result = await tool_get_weather(0, { location, timezone });
    if (!result.success || !result.response) return null;
    // Extract just the first two lines (condition + temp)
    const lines = result.response.split('\n').filter(Boolean);
    return lines.slice(1, 3).join(' · ').replace(/\*/g, '');
  } catch {
    return null;
  }
}
