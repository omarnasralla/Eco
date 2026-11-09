import { Injectable, Logger } from '@nestjs/common';
import { describeWeatherCode } from '@eco/core';
import type { WeatherDto, WeatherLocationInput, WeatherPlaceDto } from '@eco/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { localClock } from '../../common/utils/dates';

/** A day's forecast barely moves; three hours keeps it fresh without asking
 *  the provider on every page load. */
const FORECAST_TTL_SECONDS = 3 * 3600;

/** The briefing waits on this, so a slow provider must not hold it up. */
const TIMEOUT_MS = 5_000;

interface OpenMeteoForecast {
  daily?: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max?: Array<number | null>;
  };
}

interface OpenMeteoPlace {
  name: string;
  latitude: number;
  longitude: number;
  admin1?: string;
  country?: string;
}

/**
 * Today's weather where the user lives, from Open-Meteo — free, keyless, and
 * sent nothing but a city's coordinates. The place is one the user picked by
 * name; the device's location is never asked for.
 *
 * Every failure is quiet: a briefing without weather is still a briefing, and
 * a forecast provider being down must never be why it did not arrive.
 */
@Injectable()
export class WeatherService {
  private readonly logger = new Logger(WeatherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async searchPlaces(query: string): Promise<WeatherPlaceDto[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    try {
      const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
      url.search = new URLSearchParams({ name: q, count: '6', language: 'en', format: 'json' }).toString();
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Geocoder returned ${res.status}`);
      const body = (await res.json()) as { results?: OpenMeteoPlace[] };
      return (body.results ?? []).map((p) => ({
        label: [p.name, p.admin1 !== p.name ? p.admin1 : null, p.country].filter(Boolean).join(', '),
        latitude: p.latitude,
        longitude: p.longitude,
      }));
    } catch (error) {
      this.logger.warn(`Place search failed: ${(error as Error).message}`);
      return [];
    }
  }

  async setLocation(userId: string, input: WeatherLocationInput): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { weatherPlace: input.name, weatherLat: input.latitude, weatherLon: input.longitude },
    });
    await this.redis.invalidateUser(userId);
  }

  async clearLocation(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { weatherPlace: null, weatherLat: null, weatherLon: null },
    });
    await this.redis.invalidateUser(userId);
  }

  /** Today's forecast for the user's place; null with no place or no answer. */
  async today(userId: string): Promise<WeatherDto | null> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { weatherPlace: true, weatherLat: true, weatherLon: true, timezone: true },
    });
    if (!user.weatherPlace || user.weatherLat === null || user.weatherLon === null) return null;

    const { date } = localClock(user.timezone);
    // Keyed by place and day, not by user: two people in one city share a
    // forecast. Coordinates are rounded to ~1 km, finer than a forecast is.
    const key = `weather:${user.weatherLat.toFixed(2)},${user.weatherLon.toFixed(2)}:${date}`;
    let forecast = await this.redis.get<Omit<WeatherDto, 'place'>>(key);

    if (!forecast) {
      forecast = await this.fetchForecast(user.weatherLat, user.weatherLon, date);
      // Only a real answer is cached; a failure is retried next time.
      if (forecast) await this.redis.set(key, forecast, FORECAST_TTL_SECONDS);
    }
    if (!forecast) return null;

    return { place: user.weatherPlace.split(',')[0]!.trim(), ...forecast };
  }

  private async fetchForecast(
    latitude: number,
    longitude: number,
    date: string,
  ): Promise<Omit<WeatherDto, 'place'> | null> {
    try {
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.search = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        daily:
          'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
        // The place's own timezone, so "today" is the day it is there.
        timezone: 'auto',
        start_date: date,
        end_date: date,
      }).toString();
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Forecast returned ${res.status}`);
      const daily = ((await res.json()) as OpenMeteoForecast).daily;
      if (!daily || daily.time.length === 0) return null;

      return {
        date: daily.time[0]!,
        summary: describeWeatherCode(daily.weather_code[0]!),
        maxC: daily.temperature_2m_max[0]!,
        minC: daily.temperature_2m_min[0]!,
        rainChancePct: daily.precipitation_probability_max?.[0] ?? null,
      };
    } catch (error) {
      this.logger.warn(`Forecast failed: ${(error as Error).message}`);
      return null;
    }
  }
}
