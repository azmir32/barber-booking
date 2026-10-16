// A screen's last good answer, so opening it again shows what the person saw
// last time at once while it asks the server again. Answers are kept under
// the signed-in account (and the shop, day, search or area they were for),
// in memory and on the phone, for a day at most, and all go on sign out.

import { t } from './lang.ts';
import { addDays, DEFAULT_TIME_ZONE, formatDay, formatTime, localDateString, noBreak } from './time.ts';

/** Bump whenever the shape of anything kept here changes, so an update never shows an old one. */
export const CACHE_VERSION = 1;
/** Older than this, an answer would mislead more than help. */
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Most answers kept on the phone for one account; the oldest go first. */
export const CACHE_MAX_ENTRIES = 40;
/** Whose answers are kept while nobody is signed in: only Find a barber's public list. */
export const GUEST = 'guest';

const PREFIX = 'potongku.cache.';

export type Cached<T> = {
  data: T;
  /** When the server gave it, in ms. */
  at: number;
};

type Entry = { v: number; at: number; data: unknown };

/** The parts of AsyncStorage the cache uses, so a plain Map can stand in for it in tests. */
export type KeyValueStore = {
  setItem(key: string, value: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
  multiGet(keys: readonly string[]): Promise<readonly (readonly [string, string | null])[]>;
  multiRemove(keys: readonly string[]): Promise<void>;
};

/** Where one answer is kept: `cacheKey(userId, 'day', shopId, '2026-10-11')`. */
export function cacheKey(user: string, name: string, ...parts: (string | number | null | undefined)[]): string {
  return `${PREFIX}${user}.${[name, ...parts.map((p) => p ?? '')].join('|')}`;
}

const ownerOf = (key: string) => key.slice(PREFIX.length, key.indexOf('.', PREFIX.length));

export function createCache(store: KeyValueStore, clock: () => number = Date.now) {
  const memory = new Map<string, Entry>();
  // Only the signed-in account's answers are kept, so a slow answer that
  // lands after its owner signed out is dropped rather than left behind.
  let user = GUEST;

  const usable = (e: Entry | null | undefined): e is Entry =>
    Boolean(e) && e!.v === CACHE_VERSION && clock() - e!.at < CACHE_MAX_AGE_MS;

  return {
    /** Who is signed in now; null for nobody. */
    setUser(next: string | null) {
      user = next ?? GUEST;
    },

    /** The answer kept for `key`, from memory, so a screen can show it on its very first render. */
    peek<T>(key: string): Cached<T> | null {
      const e = memory.get(key);
      if (!usable(e)) {
        memory.delete(key);
        return null;
      }
      return { data: e.data as T, at: e.at };
    },

    /**
     * Keeps a good answer for next time. Searches pass persist false: the box
     * starts empty when the app opens again, so they only need to last the visit.
     */
    async write(key: string, data: unknown, persist = true): Promise<void> {
      if (ownerOf(key) !== user) return;
      const e: Entry = { v: CACHE_VERSION, at: clock(), data };
      memory.set(key, e);
      if (persist) await store.setItem(key, JSON.stringify(e)).catch(() => {});
    },

    /**
     * Reads an account's answers from the phone into memory, once when the app
     * opens, and throws out any too old, from an older version, or past the most kept.
     */
    async load(forUser: string): Promise<void> {
      try {
        const prefix = `${PREFIX}${forUser}.`;
        const keys = (await store.getAllKeys()).filter((k) => k.startsWith(prefix));
        if (keys.length === 0) return;
        const kept: [string, Entry][] = [];
        const drop: string[] = [];
        for (const [key, json] of await store.multiGet(keys)) {
          let e: Entry | null = null;
          try {
            e = json ? (JSON.parse(json) as Entry) : null;
          } catch {
            // Unreadable: dropped below.
          }
          if (usable(e)) kept.push([key, e]);
          else drop.push(key);
        }
        kept.sort((a, b) => b[1].at - a[1].at);
        drop.push(...kept.splice(CACHE_MAX_ENTRIES).map(([key]) => key));
        for (const [key, e] of kept) {
          // An answer the app already has from this visit is newer.
          if (!memory.has(key)) memory.set(key, e);
        }
        if (drop.length) await store.multiRemove(drop);
      } catch {
        // Nothing kept on this phone; screens load as they would the first time.
      }
    },

    /** Forgets every answer of every account, in memory and on the phone: on sign out and account deletion. */
    async clear(): Promise<void> {
      memory.clear();
      user = GUEST;
      try {
        const keys = (await store.getAllKeys()).filter((k) => k.startsWith(PREFIX));
        if (keys.length) await store.multiRemove(keys);
      } catch {
        // Nothing kept on this phone.
      }
    },
  };
}

export type AppCache = ReturnType<typeof createCache>;

/**
 * Said over what a screen kept from earlier when asking again failed:
 * "Couldn’t refresh. Showing what you saw at 3:05 pm.", or yesterday's, or a day's.
 */
export function staleLine(at: number, now: number, timeZone = DEFAULT_TIME_ZONE): string {
  const day = localDateString(new Date(at), timeZone);
  const today = localDateString(new Date(now), timeZone);
  const time = noBreak(formatTime(new Date(at), timeZone));
  if (day === today) return t('Couldn’t refresh. Showing what you saw at {time}.', { time });
  if (day === addDays(today, -1)) return t('Couldn’t refresh. Showing what you saw yesterday at {time}.', { time });
  return t('Couldn’t refresh. Showing what you saw on {day} at {time}.', {
    day: noBreak(formatDay(new Date(at), timeZone)),
    time,
  });
}
