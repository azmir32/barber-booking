// Ratings: when a customer can rate their cut, the name a review shows, and
// how a shop's stars read.

import { daysSince, timeSpan } from './customers.ts';
import { t } from './lang.ts';
import { formatCount } from './time.ts';

/** Days after a cut starts that its customer can rate it, or change their rating (as rate_booking allows). */
export const REVIEW_WINDOW_DAYS = 14;
/** Below this many reviews a shop shows no stars: one or two ratings say little about it. */
export const MIN_REVIEWS_SHOWN = 3;
/** Longest comment or reply, as the database allows. */
export const REVIEW_MAX_LENGTH = 280;

/** A customer's rating of their cut, as my_bookings() sends it. */
export type MyReview = {
  rating: number;
  comment: string | null;
  /** The name it shows on the shop's page. */
  first_name: string;
  reply: string | null;
  replied_at: string | null;
  created_at: string;
  updated_at: string;
};

/** A review as a shop page or the shop's owner reads it: a first name, never whose account wrote it. */
export type ShopReview = {
  booking_id: string;
  rating: number;
  comment: string | null;
  first_name: string;
  reply: string | null;
  replied_at: string | null;
  created_at: string;
  barbers: { name: string } | null;
  /** Only the shop's owner gets these: the cut that was rated. */
  bookings?: { service_name: string; starts_at: string } | null;
};

/** When the customer can no longer rate this cut, or change their rating. */
export function rateUntil(startsAt: string): Date {
  return new Date(Date.parse(startsAt) + REVIEW_WINDOW_DAYS * 86_400_000);
}

/** Whether the customer can rate this booking now, or rate it again: marked done, and started under 14 days ago. */
export function canRate(booking: { status: string; starts_at: string }, now: number): boolean {
  return booking.status === 'completed' && now < rateUntil(booking.starts_at).getTime();
}

/** Longest name a review shows, as the database allows. */
export const REVIEW_NAME_MAX_LENGTH = 40;

// The word lists below are the same in review_first_name (the migration).
/** Where the given name ends: what follows bin, binti or a/l is the father's name. */
const NAME_ENDS = new Set(['bin', 'binti', 'binte', 'bte', 'bt', 'b', 'a/l', 'a/p', 's/o', 'd/o']);
/** Passed over while another word follows: Muhammad and Mohd, titles, and hereditary names like Wan or Syed. */
const NAME_SKIPPED = new Set(
  (
    'muhammad muhamad mohammad mohamad mohammed mohamed mohd muhd mhd md ' +
    'wan nik syed sayed sharifah syarifah tengku tunku raja megat che ' +
    'dr haji hj hajah hjh encik en tuan puan cik dato datuk datin'
  ).split(' '),
);
/** Said together with the next word: Abdul Rahman, never Abdul. */
const NAME_JOINED = new Set(['abdul', 'abd']);
/**
 * Common Malaysian Chinese surnames, rarely the start of a given name: "Tan
 * Wei Jie" goes by Wei Jie. Only checked on three words, the usual shape.
 */
const CHINESE_SURNAMES = new Set(
  (
    'tan lim lee ng wong chan ong teh goh leong lau yap low cheah khoo koh chua foo loh liew yeoh ' +
    'ooi tay chew ang soh teo toh phang choong lam chai chia gan mah mak quek seow woo yeo yip choy hii ho'
  ).split(' '),
);
const nameKey = (word: string) => word.toLowerCase().replace(/[.'’]+$/, '');

/**
 * The name a review shows unless the customer picks another, as
 * review_first_name works it out: the name they go by, never a surname or
 * their father's name. "Mohd Hakim bin Ali" is Hakim, "Muhammad bin
 * Abdullah" is Muhammad, "Wan Abdul Rahman" is Abdul Rahman and "Tan Wei
 * Jie" is Wei Jie. No rule gets every name right, so the form shows it.
 */
export function firstName(fullName: string): string {
  const words = fullName.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '').split(/\s+/);
  const end = words.findIndex((w, i) => i > 0 && NAME_ENDS.has(nameKey(w)));
  let given = end > 0 ? words.slice(0, end) : words;
  while (given.length > 1 && NAME_SKIPPED.has(nameKey(given[0]))) given = given.slice(1);
  const name =
    given.length === 3 && CHINESE_SURNAMES.has(nameKey(given[0]))
      ? `${given[1]} ${given[2]}`
      : given.length > 1 && NAME_JOINED.has(nameKey(given[0]))
        ? `${given[0]} ${given[1]}`
        : given[0];
  return [...name].slice(0, REVIEW_NAME_MAX_LENGTH).join('').replace(/ +$/, '') || 'Customer';
}

/** A name the customer typed for their review: spaces tidied and cut to length; null when blank. */
export function reviewName(typed: string): string | null {
  const name = [...typed.replace(/\s+/g, ' ').replace(/^ +| +$/g, '')].slice(0, REVIEW_NAME_MAX_LENGTH).join('');
  return name.replace(/ +$/, '') || null;
}

/** The average to one decimal, as find_shops works it out; null with no reviews. */
export function ratingAverage(sum: number, count: number): number | null {
  return count > 0 ? Math.round((sum * 10) / count) / 10 : null;
}

/** "4.8", or "5.0" for a whole number, so stars line up down a list. */
export const averageText = (average: number) => average.toFixed(1);

/** "Rated 4.8 out of 5 from 23 reviews", or "from 1 review": the stars, said in words. */
export function ratingLabel(average: number, count: number): string {
  return t('Rated {avg} out of 5 from {reviews}', { avg: averageText(average), reviews: reviewCount(count) });
}

/**
 * "4.8 ★ (23)" for a shop, and what a screen reader says for it. Null until
 * the shop has a few reviews, so one unlucky rating never stands for a shop.
 */
export function ratingSummary(average: number | null, count: number): { text: string; label: string } | null {
  if (average == null || count < MIN_REVIEWS_SHOWN) return null;
  return { text: `${averageText(average)} ★ (${formatCount(count)})`, label: ratingLabel(average, count) };
}

/** "1 star" or "4 stars". */
export function starsLabel(stars: number): string {
  return stars === 1 ? t('1 star') : t('{count} stars', { count: stars });
}

/** "1 review" or "23 reviews". */
export function reviewCount(count: number): string {
  return count === 1 ? t('1 review') : t('{count} reviews', { count: formatCount(count) });
}

/** "Today", "Yesterday", "5 days ago" or "3 months ago", by the shop's calendar. */
export function reviewAge(at: string, now: number, timeZone: string): string {
  const days = daysSince(at, now, timeZone);
  if (days <= 0) return t('Today');
  if (days === 1) return t('Yesterday');
  return t('{time} ago', { time: timeSpan(days) });
}
