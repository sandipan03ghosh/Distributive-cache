/**
 * @flowcache/dashboard — hooks/useInterval.ts
 *
 * Standard "declarative setInterval" hook (the callback ref pattern
 * avoids stale-closure bugs without having to include `callback` in
 * the effect's dependency array, which would otherwise reset the timer
 * on every render).
 */

import { useEffect, useRef } from 'react';

export function useInterval(callback: () => void, delayMs: number | null): void {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (delayMs === null) return;
    const id = setInterval(() => savedCallback.current(), delayMs);
    return () => clearInterval(id);
  }, [delayMs]);
}