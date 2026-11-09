'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudSun, Loader2, MapPin, X } from 'lucide-react';
import type { WeatherDto, WeatherPlaceDto } from '@eco/shared';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Today's weather for a city the user picks by name. The device's location is
 * never requested: a city is all a forecast needs, and asking for GPS to say
 * "35° and sunny" is more than the question is worth.
 */
export function WeatherCard() {
  const { user, refreshUser } = useAuth();
  const queryClient = useQueryClient();
  const [changing, setChanging] = useState(false);

  const weather = useQuery({
    queryKey: ['weather'],
    queryFn: () => api.get<{ weather: WeatherDto | null }>('/weather'),
    enabled: Boolean(user?.weatherPlace),
  });

  const refresh = async () => {
    await refreshUser();
    await queryClient.invalidateQueries({ queryKey: ['weather'] });
    await queryClient.invalidateQueries({ queryKey: ['briefing'] });
  };

  const clear = useMutation({
    mutationFn: () => api.delete('/weather/location'),
    onSuccess: refresh,
  });

  const place = user?.weatherPlace;
  const today = weather.data?.weather;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <CloudSun className="size-4 text-muted-foreground" aria-hidden />
          Weather
        </CardTitle>
        {place && !changing ? (
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setChanging(true)}>
              Change
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Stop showing weather"
              disabled={clear.isPending}
              onClick={() => clear.mutate()}
            >
              <X className="size-4" aria-hidden />
            </Button>
          </div>
        ) : null}
      </CardHeader>
      <CardContent>
        {!place || changing ? (
          <PlacePicker
            onPicked={async () => {
              setChanging(false);
              await refresh();
            }}
            onCancel={place ? () => setChanging(false) : undefined}
          />
        ) : weather.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : today ? (
          <div className="flex items-baseline justify-between gap-3">
            <div>
              <p className="text-sm text-muted-foreground">{place}</p>
              <p className="font-medium">{today.summary}</p>
              {today.rainChancePct !== null && today.rainChancePct > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {today.rainChancePct}% chance of rain
                </p>
              ) : null}
            </div>
            <p className="tabular text-2xl font-semibold">
              {Math.round(today.maxC)}°
              <span className="text-base font-normal text-muted-foreground">
                {' '}
                / {Math.round(today.minC)}°
              </span>
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            The forecast is not available right now.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function PlacePicker({
  onPicked,
  onCancel,
}: {
  onPicked: () => void;
  onCancel?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  // One request per pause in typing, not per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(id);
  }, [query]);

  const places = useQuery({
    queryKey: ['weather', 'places', debounced],
    queryFn: () => api.get<WeatherPlaceDto[]>('/weather/places', { query: { q: debounced } }),
    enabled: debounced.length >= 2,
  });

  const pick = useMutation({
    mutationFn: (place: WeatherPlaceDto) =>
      api.put('/weather/location', {
        name: place.label,
        latitude: place.latitude,
        longitude: place.longitude,
      }),
    onSuccess: onPicked,
  });

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          placeholder="Your city"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search for your city"
          autoFocus={Boolean(onCancel)}
        />
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
      {places.isFetching ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Searching…
        </p>
      ) : debounced.length >= 2 && places.data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">No city by that name.</p>
      ) : null}
      {places.data?.length ? (
        <ul className="divide-y rounded-md border">
          {places.data.map((place) => (
            <li key={`${place.latitude},${place.longitude}`}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-muted/60"
                disabled={pick.isPending}
                onClick={() => pick.mutate(place)}
              >
                <MapPin className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                {place.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {!onCancel ? (
        <p className="text-xs text-muted-foreground">
          Pick your city to get the day&apos;s forecast here and in your morning briefing.
        </p>
      ) : null}
    </div>
  );
}
