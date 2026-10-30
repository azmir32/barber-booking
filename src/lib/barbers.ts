// Choosing a barber by more than a name: the line their owner wrote about
// them, and their stars from reviews of their cuts.

import { t } from './lang.ts';
import { averageText, MIN_REVIEWS_SHOWN, ratingAverage, ratingLabel, reviewCount } from './reviews.ts';
import { formatCount } from './time.ts';

/** Longest line about a barber, as the database allows. */
export const BARBER_ABOUT_MAX_LENGTH = 60;

/** A barber's own review count and total, kept by the database like the shop's. */
export type BarberStars = { rating_count: number; rating_sum: number };

/**
 * What the owner typed about a barber, as the database takes it: one line,
 * spaces tidied, cut to 60 characters; null when blank.
 */
export function barberAbout(typed: string): string | null {
  const line = typed.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/^ +| +$/g, '');
  return [...line].slice(0, BARBER_ABOUT_MAX_LENGTH).join('').replace(/ +$/, '') || null;
}

/** The barber's average to one decimal; null with no reviews. */
export const barberAverage = (b: BarberStars) => ratingAverage(b.rating_sum, b.rating_count);

/**
 * "4.8 ★ (12)" for any number of reviews, for the shop's owner, who sees
 * every barber's figures; customers see a barber's stars from three on.
 */
export function ownerStarsText(b: BarberStars): string | null {
  const average = barberAverage(b);
  return average == null ? null : `${averageText(average)} ★ (${formatCount(b.rating_count)})`;
}

/**
 * What a screen reader says for a barber to pick, all in one: "Ali. Skin
 * fades and beard trims. Rated 4.8 out of 5 from 12 reviews". The stars only
 * once they show.
 */
export function barberLabel(b: BarberStars & { name: string; about: string | null }): string {
  const average = barberAverage(b);
  const stars = average != null && b.rating_count >= MIN_REVIEWS_SHOWN ? ratingLabel(average, b.rating_count) : null;
  return [b.name, b.about?.replace(/[.!\s]+$/, ''), stars].filter(Boolean).join('. ');
}

/** "Ali, rated 4.8 out of 5 from 12 reviews", or just "Ali": a barber's chip over the reviews, read out. */
export function barberChipLabel(b: BarberStars & { name: string }, withStars: boolean): string {
  const average = barberAverage(b);
  return withStars && average != null
    ? t('{name}, rated {avg} out of 5 from {reviews}', {
        name: b.name,
        avg: averageText(average),
        reviews: reviewCount(b.rating_count),
      })
    : b.name;
}

/**
 * The barbers a shop's reviews can be narrowed to: each with reviews, in the
 * team's order, once there are two or more of them (one alone is everyone).
 */
export function reviewFilters<B extends BarberStars>(barbers: B[]): B[] {
  const reviewed = barbers.filter((b) => b.rating_count > 0);
  return reviewed.length > 1 ? reviewed : [];
}
