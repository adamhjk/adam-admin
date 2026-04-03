import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  latitude: z.number().default(-37.8721),
  longitude: z.number().default(175.6828),
  locationName: z.string().default("The Shire (Hobbiton, Matamata NZ)"),
  timezone: z.string().default("Pacific/Auckland"),
});

const WeatherSchema = z.object({
  locationName: z.string(),
  date: z.string(),
  temperatureCurrent: z.number().nullable(),
  temperatureHigh: z.number().nullable(),
  temperatureLow: z.number().nullable(),
  feelsLike: z.number().nullable(),
  humidity: z.number().nullable(),
  windSpeed: z.number().nullable(),
  windDirection: z.number().nullable(),
  weatherCode: z.number(),
  weatherDescription: z.string(),
  precipitationMm: z.number().nullable(),
  sunrise: z.string().nullable(),
  sunset: z.string().nullable(),
  uvIndexMax: z.number().nullable(),
  summary: z.string(),
});

// WMO Weather interpretation codes
// https://open-meteo.com/en/docs
function weatherCodeToDescription(code: number): string {
  const descriptions: Record<number, string> = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Foggy",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    56: "Light freezing drizzle",
    57: "Dense freezing drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    66: "Light freezing rain",
    67: "Heavy freezing rain",
    71: "Slight snow fall",
    73: "Moderate snow fall",
    75: "Heavy snow fall",
    77: "Snow grains",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Slight snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail",
    99: "Thunderstorm with heavy hail",
  };
  return descriptions[code] ?? `Unknown (code ${code})`;
}

function windDirectionToCompass(degrees: number): string {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                 "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(degrees / 22.5) % 16];
}

function buildSummary(data: {
  locationName: string;
  weatherDescription: string;
  temperatureCurrent: number | null;
  temperatureHigh: number | null;
  temperatureLow: number | null;
  feelsLike: number | null;
  humidity: number | null;
  windSpeed: number | null;
  windDirection: number | null;
  precipitationMm: number | null;
  sunrise: string | null;
  sunset: string | null;
}): string {
  const parts: string[] = [];
  parts.push(`Weather in ${data.locationName}: ${data.weatherDescription}.`);

  if (data.temperatureCurrent !== null) {
    parts.push(`Currently ${data.temperatureCurrent}°C`);
    if (data.feelsLike !== null && Math.abs(data.feelsLike - data.temperatureCurrent) >= 2) {
      parts.push(`(feels like ${data.feelsLike}°C)`);
    }
    parts.push(".");
  }

  if (data.temperatureHigh !== null && data.temperatureLow !== null) {
    parts.push(`High of ${data.temperatureHigh}°C, low of ${data.temperatureLow}°C.`);
  }

  if (data.humidity !== null) {
    parts.push(`Humidity: ${data.humidity}%.`);
  }

  if (data.windSpeed !== null && data.windSpeed > 0) {
    const dir = data.windDirection !== null ? ` from the ${windDirectionToCompass(data.windDirection)}` : "";
    parts.push(`Wind: ${data.windSpeed} km/h${dir}.`);
  }

  if (data.precipitationMm !== null && data.precipitationMm > 0) {
    parts.push(`Precipitation: ${data.precipitationMm}mm.`);
  }

  if (data.sunrise && data.sunset) {
    parts.push(`Sunrise: ${data.sunrise}, Sunset: ${data.sunset}.`);
  }

  return parts.join(" ");
}

export const model = {
  type: "@adam/weather/shire",
  version: "2026.04.03.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    weather: {
      description: "Current weather conditions at the Shire (Hobbiton, NZ)",
      schema: WeatherSchema,
      lifetime: "1d" as const,
      garbageCollection: 7,
    },
  },
  methods: {
    fetch: {
      description:
        "Fetch current weather and daily forecast for the Shire from Open-Meteo. Produces one weather resource per call.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: any) => {
        const { latitude, longitude, locationName, timezone } = context.globalArgs;

        const params = new URLSearchParams({
          latitude: String(latitude),
          longitude: String(longitude),
          current: "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m",
          daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,sunrise,sunset,uv_index_max,weather_code",
          timezone,
          forecast_days: "1",
        });

        const url = `https://api.open-meteo.com/v1/forecast?${params}`;
        context.logger.info("Fetching weather for {location} ({lat}, {lon})", {
          location: locationName,
          lat: latitude,
          lon: longitude,
        });

        const resp = await fetch(url);
        if (!resp.ok) {
          throw new Error(`Open-Meteo request failed: ${resp.status} ${resp.statusText}`);
        }
        const data = await resp.json();

        const current = data.current ?? {};
        const daily = data.daily ?? {};

        // Extract sunrise/sunset as local time strings
        const sunrise = daily.sunrise?.[0]
          ? daily.sunrise[0].replace(/.*T/, "")
          : null;
        const sunset = daily.sunset?.[0]
          ? daily.sunset[0].replace(/.*T/, "")
          : null;

        const today = new Intl.DateTimeFormat("en-CA", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());

        const weatherCode = current.weather_code ?? daily.weather_code?.[0] ?? 0;

        const weatherData = {
          locationName,
          date: today,
          temperatureCurrent: current.temperature_2m ?? null,
          temperatureHigh: daily.temperature_2m_max?.[0] ?? null,
          temperatureLow: daily.temperature_2m_min?.[0] ?? null,
          feelsLike: current.apparent_temperature ?? null,
          humidity: current.relative_humidity_2m ?? null,
          windSpeed: current.wind_speed_10m ?? null,
          windDirection: current.wind_direction_10m ?? null,
          weatherCode,
          weatherDescription: weatherCodeToDescription(weatherCode),
          precipitationMm: daily.precipitation_sum?.[0] ?? null,
          sunrise,
          sunset,
          uvIndexMax: daily.uv_index_max?.[0] ?? null,
          summary: "",
        };

        weatherData.summary = buildSummary(weatherData);

        context.logger.info("{summary}", { summary: weatherData.summary });

        const handle = await context.writeResource(
          "weather",
          `shire-${today}`,
          weatherData,
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
