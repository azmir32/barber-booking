# PotongKu

A booking app for barbers. Barbers sign up, list their services, chairs and hours, and share a booking link. Customers find a barber, pick a service, barber and time, and book without calling or DMing. Launching in Kajang first.

One app serves both sides: people choose "Customer" or "Barber / shop owner" when they sign up.

## What's in phase 1

**Customers**
- Browse live barbershops and search by name or area
- Book a service with a chosen barber or "any barber", from free 15-minute slots over the next 14 days
- See upcoming and past bookings, cancel, WhatsApp the shop, book again

**Barbers and shop owners**
- Create a shop with a booking link (`/shop/your-shop`)
- Services menu with prices and durations, plus quick-add suggestions
- Barbers (one per chair) with weekly working hours; a solo barber is a shop with one chair
- Bookings by day with expected takings; mark done, no-show or cancelled; WhatsApp the customer
- Go live / pause, share or copy the booking link
- One-month free trial on every new shop

**Rules enforced in the database**
- A barber can never be double-booked (Postgres exclusion constraint)
- Bookings are only created through `book_appointment`, which re-checks the slot is free and inside working hours
- Customers only see their own bookings; owners only see their own shop's bookings and customers
- Shops are only visible while published and paid up or inside the free trial

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

## Checks

```bash
npm run typecheck   # TypeScript
npm run lint        # ESLint
npm test            # date, money and phone helpers
npm run test:db     # schema + booking rules against a throwaway local Postgres 16+
```

`test:db` needs `initdb`, `pg_ctl` and `psql` installed locally (it does not need Supabase or Docker).

## Running the business side by hand (until payments are built)

- A shop's free trial ends 30 days after it is created (`shops.trial_ends_at`).
- When a barber pays, set `subscription_status = 'active'` on their shop in the Supabase table editor.
- When a trial ends without payment, the shop disappears from search and its link stops taking bookings.

## Renaming the app

The name shown in the app comes from `name` in `app.json`. Also update `slug`, `scheme`, `ios.bundleIdentifier` and `android.package` there before the first store release.

## Next phases

- WhatsApp / push reminders the day before, to cut no-shows
- Online subscription payments for barbers (FPX and cards)
- Optional deposits at booking
- Reviews and a photo gallery of cuts
- Time off and breaks for barbers
- "Find a barber near me" with a map
- Walk-in queue mode
