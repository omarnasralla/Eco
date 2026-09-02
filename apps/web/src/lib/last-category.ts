'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'eco:last-category';

/**
 * The category the expense form starts on, remembered per browser.
 *
 * Category is a required field, so without this every entry costs two extra
 * taps — open the picker, choose — and spending repeats far more often than it
 * varies: the same commute, the same lunch, the same shop. Prefilling the last
 * one makes the common case a single amount and a save, and picking a different
 * category is exactly as easy as it was before.
 *
 * The stored id is validated against the categories actually returned for this
 * account before it is used, so an id from a deleted category, or from another
 * account on a shared browser, is discarded rather than submitted.
 */
export function useLastCategory(
  availableIds: string[],
): [string | null, (next: string) => void] {
  const [categoryId, setCategoryId] = useState<string | null>(null);

  useEffect(() => {
    if (availableIds.length === 0) return;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // Private mode or storage disabled; starting empty is a fine answer.
    }
    setCategoryId(stored && availableIds.includes(stored) ? stored : null);
    // Depends on the joined ids rather than the array identity, which is a new
    // reference on every render of the parent query.
  }, [availableIds.join(',')]);

  const remember = useCallback((next: string) => {
    setCategoryId(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Failing to remember must never block the save.
    }
  }, []);

  return [categoryId, remember];
}
