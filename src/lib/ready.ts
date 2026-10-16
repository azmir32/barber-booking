// Getting a new shop to its first booking: the steps on My shop's "Get your
// shop ready" card, which are done, and what Go live is still missing.
// Worked out from the shop, what shop_setup says it has, and what this phone
// remembers about the card.

import { t } from './lang.ts';
import type { Shop } from './types.ts';

/** What shop_setup says the shop has: services customers can book, and the active barbers with whether each has hours. */
export type ShopSetup = {
  services: number;
  barbers: { id: string; name: string; has_hours: boolean }[];
};

/** What this phone remembers about a shop's card. */
export type ReadyMemory = {
  /** The card showed here while the shop had never been live, so it stays through going live until done. */
  started?: boolean;
  /** The booking link was shared or copied here, or the poster opened. */
  shared?: boolean;
  /** Hidden, or it has said the shop is ready: gone for good. */
  closed?: boolean;
};

export type StepId = 'services' | 'barbers' | 'location' | 'live' | 'share';
export type ReadyStep = { id: StepId; done: boolean; optional: boolean };

/** Where this phone keeps a shop's card memory. Not in the cache, so it outlasts signing out. */
export const readyKey = (shopId: string) => `potongku.shopReady.${shopId}`;

/** A shop's card memory as kept on the phone; anything unreadable is a fresh start. */
export function parseMemory(json: string | null | undefined): ReadyMemory {
  try {
    const kept = json ? (JSON.parse(json) as unknown) : null;
    if (!kept || typeof kept !== 'object') return {};
    const { started, shared, closed } = kept as Record<string, unknown>;
    return { started: started === true, shared: shared === true, closed: closed === true };
  } catch {
    return {};
  }
}

/**
 * Whether My shop shows the card: for a shop that has never been live, and
 * for one this phone walked through going live, until it is closed. So a
 * shop that was live before the card existed never sees it.
 */
export function readyCardShows(shop: Pick<Shop, 'published_at'>, memory: ReadyMemory): boolean {
  return !memory.closed && (shop.published_at == null || Boolean(memory.started));
}

/** Subscribed, or still in the free month. */
export const paidUp = (shop: Pick<Shop, 'subscription_status' | 'trial_ends_at'>, now: number) =>
  shop.subscription_status === 'active' ||
  (shop.subscription_status === 'trialing' && Date.parse(shop.trial_ends_at) > now);

/** Customers can find the shop and book: published and paid up, as the database decides (shop_is_live). */
export const takesBookings = (
  shop: Pick<Shop, 'is_published' | 'subscription_status' | 'trial_ends_at'>,
  now: number,
) => shop.is_published && paidUp(shop, now);

/**
 * The steps in the order they are done. Where the shop is helps, but a shop
 * can open without it. Live only counts while customers can book, so a shop
 * hidden for being unpaid is never called ready.
 */
export function readySteps(
  shop: Pick<Shop, 'latitude' | 'is_published' | 'subscription_status' | 'trial_ends_at'>,
  setup: ShopSetup,
  memory: ReadyMemory,
  now: number,
): ReadyStep[] {
  return [
    { id: 'services', done: setup.services > 0, optional: false },
    { id: 'barbers', done: setup.barbers.some((b) => b.has_hours), optional: false },
    { id: 'location', done: shop.latitude != null, optional: true },
    { id: 'live', done: takesBookings(shop, now), optional: false },
    { id: 'share', done: Boolean(memory.shared), optional: false },
  ];
}

/** How many of the steps that count are done, and whether that is all of them. */
export function readyProgress(steps: ReadyStep[]): { done: number; total: number; ready: boolean } {
  const counted = steps.filter((s) => !s.optional);
  const done = counted.filter((s) => s.done).length;
  return { done, total: counted.length, ready: done === counted.length };
}

/** "2 of 4 done". */
export const progressText = ({ done, total }: { done: number; total: number }) =>
  t('{done} of {total} done', { done, total });

/** The first step that counts and isn't done yet, so the optional one never reads as needed; null once all are. */
export function nextStep(steps: ReadyStep[]): StepId | null {
  return steps.find((s) => !s.done && !s.optional)?.id ?? null;
}

/**
 * Whose hours to set while no barber has any: the first in the team's order.
 * Null once one has hours, or with nobody on the team (they add a barber first).
 */
export function barberWithoutHours(setup: ShopSetup): { id: string; name: string } | null {
  if (setup.barbers.some((b) => b.has_hours)) return null;
  const first = setup.barbers[0];
  return first ? { id: first.id, name: first.name } : null;
}

/** What stops the shop going live, as the database checks it: nothing to book, no times, both, or nothing. */
export type GoLiveGap = 'services' | 'hours' | 'both' | null;

export function goLiveGap(setup: ShopSetup): GoLiveGap {
  const services = setup.services > 0;
  const hours = setup.barbers.some((b) => b.has_hours);
  return services && hours ? null : !services && !hours ? 'both' : !services ? 'services' : 'hours';
}
