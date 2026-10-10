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

/** Words before the name people go by: "Mohd Hakim bin Ali" is Hakim. */
const NAME_PREFIXES = new Set([
  'muhammad',
  'muhamad',
  'mohammad',
  'mohamad',
  'mohammed',
  'mohamed',
  'mohd',
  'muhd',
  'mhd',
  'md',
]);

/**
 * The name a review shows, as rate_booking picks it: the first word of the
 * customer's name, or the next one after Muhammad or Mohd. Never a surname.
 */
export function firstName(fullName: string): string {
  const words = fullName.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '').split(/\s+/);
  const skip = words.length > 1 && words[1] !== '' && NAME_PREFIXES.has(words[0].replace(/\.+$/, '').toLowerCase());
  const name = [...(skip ? words[1] : words[0])].slice(0, 40).join('');
  return name || 'Customer';
}

/** The average to one decimal, as find_shops works it out; null with no reviews. */
export function ratingAverage(sum: number, count: number): number | null {
  return count > 0 ? Math.round((sum * 10) / count) / 10 : null;
}

/** "4.8", or "5.0" for a whole number, so stars line up down a list. */
export const averageText = (average: number) => average.toFixed(1);

/** "Rated 4.8 out of 5 from 23 reviews": the stars, said in words. */
export function ratingLabel(average: number, count: number): string {
  return t('Rated {avg} out of 5 from {count} reviews', { avg: averageText(average), count: formatCount(count) });
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
