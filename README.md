# PotongKu

A booking app for barbers. Barbers sign up, list their services, chairs and hours, and share a booking link. Customers find a barber, pick a service, barber and time, and book without calling or DMing. Launching in Kajang first.

One app serves both sides: people choose "Customer" or "Barber / shop owner" when they sign up.

## What's in phase 1

**Everyone**
- Email and password sign-in, with password reset by emailed code
- Delete account from the Account screen (required by the App Store and Google Play)

**Customers**
- Browse live barbershops and search by name or area
- Book a service with a chosen barber or "any barber", from free 15-minute slots over the next 14 days, with an optional note for the barber
- Pick a time first and sign up after; the chosen slot is kept
- See upcoming and past bookings, cancel, WhatsApp the shop, book again

**Barbers and shop owners**
- Create a shop with a booking link (`/shop/your-shop`)
- Services menu with prices and durations, plus quick-add suggestions
- Barbers (one per chair) with weekly working hours and an optional daily break (e.g. Friday prayers); a solo barber is a shop with one chair
- Bookings by day with expected takings, refreshed every minute and by pulling down; mark done or no-show once the time has started, cancel, WhatsApp the customer
- Add walk-in, WhatsApp or phone bookings, and block time or a whole day off, so online customers can't take those times
- Go live / pause, share or copy the booking link
- One-month free trial on every new shop

**Rules enforced in the database**
- A barber can never be double-booked (Postgres exclusion constraint)
- Bookings are only created through `book_appointment` (customers) and `add_shop_booking` (owners), which re-check the slot is free and inside working hours
- Customers only see their own bookings; owners only see their own shop's bookings and customers
- Shops are only visible while published and paid up or inside the free trial
- Owners can't change their own trial or subscription status
- Limits against abuse: bookings at most 60 days ahead, at most 4 upcoming bookings per customer per shop, notes up to 280 characters
- Barbers with booking history can't be deleted (mark them away instead), so past bookings keep their barber

## Tech

- [Expo](https://expo.dev) SDK 57 with Expo Router (iOS, Android and web from one codebase)
- [Supabase](https://supabase.com) for sign-in, Postgres and row-level security
- Schema and functions: [`supabase/migrations`](supabase/migrations)

## Getting it running

1. Create a free project at [supabase.com](https://supabase.com).
2. Apply the database schema, either:
   - paste `supabase/migrations/20261005000000_init.sql` into the Supabase SQL editor and run it, or
   - with the Supabase CLI: `supabase link --project-ref <ref>` then `supabase db push`.
3. Copy `.env.example` to `.env` and fill in the project URL and anon key (Supabase: Project Settings > API).
4. Install and start:

   ```bash
   npm install
   npx expo start
   ```

   Scan the QR code with the Expo Go app on your phone, or press `w` for the web version.

Tip for testing: in Supabase under Authentication > Sign In / Providers > Email, you can turn off "Confirm email" so new accounts can sign in straight away.

### Emails (password reset)

"Forgot password?" emails a 6-digit code instead of a link, so it works the same in the app and on the web. Two settings in Supabase under Authentication > Emails:

1. In the **Reset password** template, add the code, for example: `<p>Your PotongKu code is <strong>{{ .Token }}</strong></p>`.
2. Before launch, set up **SMTP settings** with an email provider (Resend, Brevo, etc.). Supabase's built-in sender only delivers to your own team's addresses and a few emails an hour.

## Checks

```bash
npm run typecheck   # TypeScript
npm run lint        # ESLint
npm test            # date, money and phone helpers
npm run test:db     # schema + booking rules against a throwaway local Postgres 16+
npm run test:e2e    # the whole app in a browser: barber sets up, customers book
```

`test:db` needs `initdb`, `pg_ctl` and `psql` installed locally (it does not need Supabase or Docker).

`test:e2e` builds the web app and runs it against a local stand-in for Supabase (Postgres, [PostgREST](https://github.com/PostgREST/postgrest/releases) 12 and a small auth gateway in `e2e/backend`). It needs Postgres 16+, the PostgREST binary on your `PATH` (or `POSTGREST=/path/to/postgrest`) and Playwright's Chromium (`npx playwright install chromium`). Set `SCREENSHOTS=<folder>` to save a screenshot of each step there, and `COLOR_SCHEME=dark` to run in dark mode.

GitHub Actions runs all of these on every push (`.github/workflows/ci.yml`).

## Running the business side by hand (until payments are built)

- A shop's free trial ends 30 days after it is created (`shops.trial_ends_at`).
- When a barber pays, set `subscription_status = 'active'` on their shop in the Supabase table editor.
- When a trial ends without payment, the shop disappears from search and its link stops taking bookings.

## Renaming the app

The name shown in the app comes from `name` in `app.json`. Also update `slug`, `scheme`, `ios.bundleIdentifier` and `android.package` there before the first store release. The icon, splash and favicon are drawn by `node scripts/make-icons.mjs` (a scissors on the brand red); change `BRAND` there and re-run it.

## Next phases

- WhatsApp / push reminders the day before, to cut no-shows
- Online subscription payments for barbers (FPX and cards)
- Optional deposits at booking
- Reviews and a photo gallery of cuts
- Shop-wide holidays (e.g. closing every chair for Hari Raya in one step)
- "Find a barber near me" with a map
- Walk-in queue mode
