-- Barber booking: core schema for phase 1.
-- Shops own barbers (chairs), services and working hours. Customers book a
-- service with a barber at a time slot. All times are stored as timestamptz;
-- each shop has a time zone (Kajang launch: Asia/Kuala_Lumpur).

create extension if not exists btree_gist;

create type public.user_role as enum ('customer', 'barber');
create type public.booking_status as enum ('confirmed', 'cancelled', 'completed', 'no_show');

-- Profiles ------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role public.user_role not null default 'customer',
  full_name text not null check (length(full_name) <= 80),
  -- A blank name left the barber with a booking from nobody, and the
  -- customer's WhatsApp messages read "this is ."
  constraint profiles_full_name_not_blank check (length(trim(full_name)) > 0),
  phone text check (length(phone) <= 20),
  created_at timestamptz not null default now()
);

-- Create a profile whenever someone signs up. The app passes role, full_name
-- and phone in the sign-up metadata, and always a name. An account made
-- another way (say, by hand in the Supabase dashboard) is named after its
-- email instead, so it can still be created.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role, full_name, phone)
  values (
    new.id,
    case when new.raw_user_meta_data ->> 'role' = 'barber' then 'barber'::public.user_role
         else 'customer'::public.user_role end,
    coalesce(
      nullif(left(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 80), ''),
      nullif(left(trim(split_part(coalesce(new.email, ''), '@', 1)), 80), ''),
      'Customer'
    ),
    nullif(left(trim(coalesce(new.raw_user_meta_data ->> 'phone', '')), 20), '')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Shops ---------------------------------------------------------------------

create table public.shops (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references public.profiles (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  slug text not null unique
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 40),
  about text check (length(about) <= 500),
  address text check (length(address) <= 200),
  area text not null default 'Kajang' check (length(area) between 1 and 60),
  -- Where the shop is, which the owner sets from their phone while standing
  -- in it: Near me lists the closest shops first, and Directions go to the
  -- door rather than wherever the address search lands. Both or neither.
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  constraint shops_location_pair check ((latitude is null) = (longitude is null)),
  phone text check (length(phone) <= 20),
  instagram text check (length(instagram) <= 60),
  time_zone text not null default 'Asia/Kuala_Lumpur',
  is_published boolean not null default false,
  -- When the shop first went live (set by shops_first_published below), so
  -- My shop can tell a paused shop from one that has never been live.
  published_at timestamptz,
  -- Billing: every shop starts with a one-month free trial. Until payments are
  -- built, an admin sets subscription_status = 'active' by hand.
  trial_ends_at timestamptz not null default now() + interval '30 days',
  subscription_status text not null default 'trialing'
    check (subscription_status in ('trialing', 'active', 'past_due', 'cancelled')),
  -- How many reviews the shop has and their stars added up, kept by the
  -- reviews_count trigger, so shop lists never add up reviews per row.
  -- Owners can't write them (see the grants below).
  rating_count int not null default 0,
  rating_sum int not null default 0,
  -- Customers can join a queue for walk-ins from the shop's page while it
  -- is open (see the walk-in queue below). The owner's choice; off at first.
  queue_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

-- A shop is live (visible and bookable) when the owner published it and it is
-- paid up or still inside the free trial.
create function public.shop_is_live(s public.shops)
returns boolean
language sql
stable
as $$
  select s.is_published
     and (s.subscription_status = 'active'
          or (s.subscription_status = 'trialing' and s.trial_ends_at > now()));
$$;

create function public.owns_shop(p_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from shops where id = p_shop_id and owner_id = auth.uid());
$$;

-- Notes when a shop first goes live. Owners can't write published_at
-- themselves (see the grants below), and pausing keeps it.
create function public.shops_first_published()
returns trigger
language plpgsql
as $$
begin
  if new.is_published and new.published_at is null then
    new.published_at := now();
  end if;
  return new;
end;
$$;

create trigger shops_first_published
  before insert or update on public.shops
  for each row execute function public.shops_first_published();

-- Find a barber's first page, in name order, straight off an index rather
-- than sorting every live shop (find_shops).
create index shops_name_idx on public.shops (lower(name), id);

-- The signed-in barber's shop (an owner has at most one), or null. Policies
-- call it as (select public.my_shop_id()) so Postgres works it out once per
-- query instead of once per row, and can use the shop_id indexes. plpgsql,
-- so a connection plans its query once rather than on every owner's request.
create function public.my_shop_id()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return (select id from shops where owner_id = auth.uid());
end;
$$;

-- Barbers (one per chair) ---------------------------------------------------

create table public.barbers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 40),
  -- One short line the owner writes, shown under the name when customers
  -- pick a barber: "Fades and skin fades, 8 years". Plain text on one line.
  about text constraint barbers_about_check
    check (length(about) <= 60 and btrim(about) <> '' and about !~ '[[:cntrl:]]'),
  is_active boolean not null default true,
  sort_order int not null default 0,
  -- How many reviews of cuts with this barber and their stars added up,
  -- kept by the reviews_count trigger like the shop's, so the shop's page
  -- has each barber's stars with the barbers it already loads. Only counts
  -- and totals: nothing here says who wrote what. Owners can't write them
  -- (see the grants below).
  rating_count int not null default 0,
  rating_sum int not null default 0,
  created_at timestamptz not null default now()
);
create index barbers_shop_id_idx on public.barbers (shop_id);

-- Services ------------------------------------------------------------------

create table public.services (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  duration_min int not null check (duration_min between 5 and 480),
  price numeric(10, 2) not null check (price between 0 and 10000),
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index services_shop_id_idx on public.services (shop_id);

-- Working hours: one or more ranges per barber per weekday (0 = Sunday). -----

create table public.working_hours (
  id uuid primary key default gen_random_uuid(),
  barber_id uuid not null references public.barbers (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  opens_at time not null,
  closes_at time not null,
  check (closes_at > opens_at),
  -- Ranges for the same barber and day may not overlap.
  constraint working_hours_no_overlap exclude using gist (
    barber_id with =,
    weekday with =,
    tsrange(date '2000-01-01' + opens_at, date '2000-01-01' + closes_at) with &&
  )
);

-- A shop goes live only with something customers can book: a service, and a
-- barber who works at least one day a week. Without them it was listed with
-- no prices and closed every day, and its page had nothing to pick. Checked
-- when it goes live or back on after a pause, which owners do with an update
-- (they can't create a shop already live, see the grants below). Hiding
-- services or marking barbers away later is the owner's call; the shop's
-- page then says it isn't taking online bookings.
create function public.shops_ready_to_go_live()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from services v where v.shop_id = new.id and v.is_active) then
    raise exception 'Add a service before you go live, so customers have something to book.' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from barbers b
    where b.shop_id = new.id and b.is_active
      and exists (select 1 from working_hours wh where wh.barber_id = b.id)
  ) then
    raise exception 'Add a barber with working hours before you go live, so customers can pick a time.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke execute on function public.shops_ready_to_go_live() from public, anon, authenticated;

create trigger shops_ready_to_go_live
  before update of is_published on public.shops
  for each row when (new.is_published and not old.is_published)
  execute function public.shops_ready_to_go_live();

-- Bookings ------------------------------------------------------------------

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  -- Barbers with booking history can't be deleted, only marked away.
  barber_id uuid not null references public.barbers (id),
  service_id uuid references public.services (id) on delete set null,
  -- Online bookings have a customer account. Bookings the shop adds itself
  -- (walk-ins, WhatsApp, phone calls) carry a guest name instead, and
  -- blocked time (breaks, errands) has neither.
  customer_id uuid references public.profiles (id) on delete cascade,
  guest_name text check (length(guest_name) <= 80),
  guest_phone text check (length(guest_phone) <= 20),
  is_block boolean not null default false,
  -- Snapshot of the service at booking time, so later price edits don't
  -- rewrite history. For blocked time this is the reason.
  service_name text not null check (length(service_name) <= 80),
  price numeric(10, 2) not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status public.booking_status not null default 'confirmed',
  customer_note text check (length(customer_note) <= 280),
  -- When the shop last WhatsApped the customer a reminder, so every phone in
  -- the shop knows. Cleared when the booking moves.
  reminded_at timestamptz,
  -- When the customer last booked, moved or cancelled it themselves, and
  -- which, so the shop's phones can show what changed since they last
  -- looked. The shop's own changes don't count: it made them. Stamped with
  -- clock_timestamp() under the shop's diary lock, so the times follow the
  -- order changes are saved in, and a phone that has seen up to one time
  -- can't miss a change saved after it with an earlier time.
  customer_changed_at timestamptz,
  customer_change text check (customer_change in ('booked', 'moved', 'cancelled')),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (is_block or customer_id is not null or guest_name is not null),
  constraint bookings_customer_change_pair check ((customer_changed_at is null) = (customer_change is null)),
  -- A barber can never be double-booked.
  constraint bookings_no_overlap exclude using gist (
    barber_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status <> 'cancelled')
);
create index bookings_shop_starts_idx on public.bookings (shop_id, starts_at);
-- shop_id is in here for the per-shop booking limit and so a shop owner's
-- check on each customer's name stays one index lookup however long the
-- shop's history grows.
create index bookings_customer_idx on public.bookings (customer_id, shop_id, starts_at);
-- A shop's latest customer changes (shop_changes), asked for every minute by
-- every barber's phone. Only online bookings have one.
create index bookings_shop_changes_idx on public.bookings (shop_id, customer_changed_at)
  where customer_changed_at is not null;
-- A shop's blocked time (breaks, errands, days off), which the shop list's
-- hours today, the booking page's closed days and the waiting list look for
-- among a day's bookings. Blocks are few, so this finds them without
-- reading every booking of the days asked about.
create index bookings_shop_blocks_idx on public.bookings (shop_id, starts_at) where is_block;

-- Days the whole shop is shut, like Hari Raya. Kept apart from the barbers'
-- own blocks so reopening never touches them, and so a barber who joins
-- later is closed on those days too.
create table public.shop_closures (
  shop_id uuid not null references public.shops (id) on delete cascade,
  day date not null,
  reason text check (length(reason) <= 80),
  primary key (shop_id, day)
);

-- Reviews: one per booking, by the customer who had the cut, with the
-- shop's reply. Written only by rate_booking and reply_to_review. The
-- reviewer's first name is copied in when they rate, so a shop's page
-- shows it without reading their profile (and never their surname or
-- number). updated_at is when the customer last changed their rating.
create table public.reviews (
  booking_id uuid primary key references public.bookings (id) on delete cascade,
  shop_id uuid not null references public.shops (id) on delete cascade,
  barber_id uuid not null references public.barbers (id),
  customer_id uuid not null references public.profiles (id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  comment text check (length(comment) <= 280),
  first_name text not null check (length(first_name) <= 40),
  reply text check (length(reply) <= 280),
  replied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((reply is null) = (replied_at is null))
);
-- A shop's newest reviews, a page at a time, and its newest with a comment
-- (My shop's card), each one index lookup however many it has.
create index reviews_shop_created_idx on public.reviews (shop_id, created_at desc, booking_id);
create index reviews_shop_commented_idx on public.reviews (shop_id, created_at desc) where comment is not null;
-- One barber's reviews, newest first, when a shop's reviews are narrowed to
-- them: one index lookup however many the shop has. Also what deleting a
-- barber checks for reviews of their cuts.
create index reviews_barber_created_idx on public.reviews (barber_id, created_at desc, booking_id);
-- So deleting an account finds its reviews without reading everyone's.
create index reviews_customer_idx on public.reviews (customer_id);

-- The waiting list: a customer who found a day full asks to hear if a time
-- frees up, for one service with a chosen barber (or any). day is the
-- shop's own date. The shop sees who asked and WhatsApps them a time;
-- offered_at is when it last did, so every phone in the shop knows. A
-- request ends when its customer books there that day, and past days are
-- left out wherever requests are read, so nothing has to clear them on a
-- timer. Read and written only through the functions below.
create table public.waitlist (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  customer_id uuid not null references public.profiles (id) on delete cascade,
  day date not null,
  service_id uuid not null references public.services (id) on delete cascade,
  -- Null: any barber.
  barber_id uuid references public.barbers (id) on delete cascade,
  offered_at timestamptz,
  created_at timestamptz not null default now(),
  -- One request per customer per shop per day. Customer first, so it is
  -- also how a customer's own requests are found.
  constraint waitlist_one_a_day unique (customer_id, day, shop_id)
);
-- A shop's requests for one day, oldest first: the barber's day and the
-- news card's count, one index lookup however long the shop's history.
create index waitlist_shop_day_idx on public.waitlist (shop_id, day, created_at);

-- The walk-in queue: at a shop that takes walk-ins in turn, customers join
-- today's queue from its page and the shop adds people who walk in, by
-- name. day is the shop's own date, and days gone by are left out wherever
-- the queue is read, so nothing clears it on a timer. An entry waits in the
-- order it joined until the shop calls it (called_at, so the customer sees
-- it is their turn), then goes (gone_at): served (its cut is booking_id),
-- left, taken off, or not here when called. Read and written only through
-- the functions below.
create table public.queue_entries (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  day date not null,
  -- Customers who joined online have an account; walk-ins a name instead.
  customer_id uuid references public.profiles (id) on delete cascade,
  guest_name text check (length(guest_name) <= 80),
  guest_phone text check (length(guest_phone) <= 20),
  -- Null: not said yet (the shop picks one when the cut starts).
  service_id uuid references public.services (id) on delete set null,
  -- Null: any barber.
  barber_id uuid references public.barbers (id) on delete set null,
  state text not null default 'waiting' check (state in ('waiting', 'called', 'gone')),
  gone_reason text check (gone_reason in ('left', 'removed', 'not_here', 'served')),
  called_at timestamptz,
  -- When it went, so a customer the shop took off is told so for a while.
  gone_at timestamptz,
  booking_id uuid references public.bookings (id) on delete set null,
  created_at timestamptz not null default now(),
  check (customer_id is not null or guest_name is not null),
  constraint queue_entries_gone_reason check ((state = 'gone') = (gone_reason is not null)),
  constraint queue_entries_called_at check (state <> 'called' or called_at is not null)
);
-- A shop's queue today in order: its page's count, the barber's day and
-- Find a barber's count, one index lookup however long the shop's history.
-- Only those still waiting or called are in it, so however many come and
-- go in a day (someone joining and leaving over and over), those reads stay
-- the size of the queue.
create index queue_entries_shop_day_idx on public.queue_entries (shop_id, day, created_at)
  where state <> 'gone';
-- The rest are found by shop only when the shop is deleted.
create index queue_entries_shop_idx on public.queue_entries (shop_id);
-- A customer's own place, today or yesterday, without reading their history.
create index queue_entries_customer_day_idx on public.queue_entries (customer_id, day)
  where customer_id is not null;
-- Deleting a booking clears the entry it served. Without this, deleting a
-- shop with years of bookings read the whole queue once for each of them.
create index queue_entries_booking_idx on public.queue_entries (booking_id)
  where booking_id is not null;

-- Photos of the shop's cuts, which customers look through on its page to
-- pick a barber by their work. The files are in the shop-photos bucket (at
-- the end of this file), in a folder named after the shop: path is the
-- photo, at most 1600 px on its long side, and thumb_path a copy about 400
-- px across for strips and grids, so nothing has to resize them on the way
-- out. barber_id is who did the cut, when the owner says. Shown by
-- sort_order, lowest first: a new photo goes last, and Move to first gives
-- one a lower number than the rest. The owner writes the table straight,
-- under the policies and grants below; shop_photos_check keeps a shop to
-- 24. Removing a photo's row doesn't remove its files: the app does that
-- through Supabase Storage (see README, "Photos of the shop's cuts").
create table public.shop_photos (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  barber_id uuid references public.barbers (id) on delete set null,
  -- One short line, like a barber's: "Skin fade with a hard part".
  caption text constraint shop_photos_caption_check
    check (length(caption) <= 60 and btrim(caption) <> '' and caption !~ '[[:cntrl:]]'),
  path text not null unique,
  thumb_path text not null unique,
  width int not null check (width between 1 and 1600),
  height int not null check (height between 1 and 1600),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  -- Both files in the shop's own folder, the only one its owner can write to.
  constraint shop_photos_in_shop_folder check (
    split_part(path, '/', 1) = shop_id::text and path ~ '^[^/]+/[A-Za-z0-9_.-]+$'
    and split_part(thumb_path, '/', 1) = shop_id::text and thumb_path ~ '^[^/]+/[A-Za-z0-9_.-]+$'
    and thumb_path <> path
  )
);
-- A shop's photos in order, and Find a barber's first one for each shop:
-- one index lookup however many shops there are.
create index shop_photos_shop_order_idx on public.shop_photos (shop_id, sort_order, created_at, id);
-- Deleting a barber clears the photos tagged with them.
create index shop_photos_barber_idx on public.shop_photos (barber_id) where barber_id is not null;

-- The most photos a shop keeps: two dozen fill a page without slowing it.
create function public.max_shop_photos() returns int language sql immutable as $$ select 24 $$;

-- A photo's barber works at its shop, a shop keeps at most 24 photos, and a
-- new one goes last. Under a lock per shop, so two phones adding the 24th
-- at once can't both get in.
create function public.shop_photos_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.barber_id is not null
     and not exists (select 1 from barbers b where b.id = new.barber_id and b.shop_id = new.shop_id) then
    raise exception 'Barber not found.' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('shop-photos:' || new.shop_id, 0));
    if (select count(*) from shop_photos p where p.shop_id = new.shop_id) >= public.max_shop_photos() then
      raise exception 'Your shop has 24 photos, the most it can have. Remove one to add another.'
        using errcode = 'P0001';
    end if;
    new.sort_order := coalesce((select max(p.sort_order) + 1 from shop_photos p where p.shop_id = new.shop_id), 0);
  end if;
  return new;
end;
$$;
revoke execute on function public.shop_photos_check() from public, anon, authenticated;
revoke execute on function public.max_shop_photos() from public, anon, authenticated;

create trigger shop_photos_check
  before insert or update of barber_id on public.shop_photos
  for each row execute function public.shop_photos_check();

-- Keeps shops.rating_count and rating_sum in step with the shop's reviews,
-- and each barber's with the reviews of their cuts, also when a review
-- moves to another barber. Runs as the tables' owner, since nobody else may
-- write those columns.
create function public.reviews_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update shops set rating_count = rating_count + 1, rating_sum = rating_sum + new.rating where id = new.shop_id;
    update barbers set rating_count = rating_count + 1, rating_sum = rating_sum + new.rating where id = new.barber_id;
  elsif tg_op = 'DELETE' then
    update shops set rating_count = rating_count - 1, rating_sum = rating_sum - old.rating where id = old.shop_id;
    update barbers set rating_count = rating_count - 1, rating_sum = rating_sum - old.rating where id = old.barber_id;
  else
    if new.rating <> old.rating then
      update shops set rating_sum = rating_sum - old.rating + new.rating where id = new.shop_id;
    end if;
    if new.barber_id <> old.barber_id then
      update barbers set rating_count = rating_count - 1, rating_sum = rating_sum - old.rating where id = old.barber_id;
      update barbers set rating_count = rating_count + 1, rating_sum = rating_sum + new.rating where id = new.barber_id;
    elsif new.rating <> old.rating then
      update barbers set rating_sum = rating_sum - old.rating + new.rating where id = new.barber_id;
    end if;
  end if;
  return null;
end;
$$;
revoke execute on function public.reviews_count() from public, anon, authenticated;

create trigger reviews_count
  after insert or delete or update of rating, barber_id on public.reviews
  for each row execute function public.reviews_count();

-- A review is of the cut with the barber who did it. The booking functions
-- never move a cut once it is done, but should a rated booking's barber be
-- put right (say, by hand in the table editor), its review goes with it, and
-- reviews_count moves it from one barber's stars to the other's.
create function public.bookings_review_barber()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update reviews set barber_id = new.barber_id where booking_id = new.id;
  return null;
end;
$$;
revoke execute on function public.bookings_review_barber() from public, anon, authenticated;

create trigger bookings_review_barber
  after update of barber_id on public.bookings
  for each row when (new.barber_id <> old.barber_id)
  execute function public.bookings_review_barber();

-- Row level security --------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.shops enable row level security;
alter table public.barbers enable row level security;
alter table public.services enable row level security;
alter table public.working_hours enable row level security;
alter table public.bookings enable row level security;
-- No policies: read and written only through the functions below.
alter table public.shop_closures enable row level security;
alter table public.reviews enable row level security;
alter table public.waitlist enable row level security;
alter table public.queue_entries enable row level security;
alter table public.shop_photos enable row level security;

-- Policies wrap auth.uid() and my_shop_id() in (select ...) so they run once
-- per query. Checked per row, a query over every booking took over a minute
-- with a Malaysia-sized table (e2e/load).
create policy "read own profile" on public.profiles
  for select using (id = (select auth.uid()));
create policy "shop owners read their customers" on public.profiles
  for select using (
    exists (
      select 1 from public.bookings b
      where b.customer_id = profiles.id and b.shop_id = (select public.my_shop_id())
    )
  );
create policy "update own profile" on public.profiles
  for update using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "read live or own shops" on public.shops
  for select using (public.shop_is_live(shops) or owner_id = (select auth.uid()));
create policy "barbers create their shop" on public.shops
  for insert with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'barber')
  );
create policy "owners update their shop" on public.shops
  for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

-- Barbers, services and hours are visible when their shop is: the shops and
-- barbers policies decide that inside these subqueries.
create policy "read barbers of visible shops" on public.barbers
  for select using (exists (select 1 from public.shops s where s.id = shop_id));
create policy "owners manage barbers" on public.barbers
  for all using (shop_id = (select public.my_shop_id()))
  with check (shop_id = (select public.my_shop_id()));

create policy "read services of visible shops" on public.services
  for select using (exists (select 1 from public.shops s where s.id = shop_id));
create policy "owners manage services" on public.services
  for all using (shop_id = (select public.my_shop_id()))
  with check (shop_id = (select public.my_shop_id()));

create policy "read hours of visible shops" on public.working_hours
  for select using (exists (select 1 from public.barbers b where b.id = barber_id));
create policy "owners manage hours" on public.working_hours
  for all using (
    exists (select 1 from public.barbers b where b.id = barber_id and b.shop_id = (select public.my_shop_id()))
  ) with check (
    exists (select 1 from public.barbers b where b.id = barber_id and b.shop_id = (select public.my_shop_id()))
  );

-- Bookings are read directly but only written through the functions below.
create policy "customers and shop owners read bookings" on public.bookings
  for select using (customer_id = (select auth.uid()) or shop_id = (select public.my_shop_id()));

-- Anyone reads the reviews of a live shop, and its owner all of theirs (the
-- shops policy decides inside the subquery). Reviewers always see their own.
-- A scalar subquery rather than exists: Postgres turned exists into a scan
-- of every shop on each request, where this looks up the one shop per row.
create policy "read reviews of visible shops, and your own" on public.reviews
  for select using (
    coalesce((select true from public.shops s where s.id = shop_id), false) or customer_id = (select auth.uid())
  );

-- Anyone sees a live shop's photos, and its owner all of theirs, in the same
-- way. Only the owner adds, changes or removes them.
create policy "read photos of visible shops" on public.shop_photos
  for select using (coalesce((select true from public.shops s where s.id = shop_id), false));
create policy "owners manage their photos" on public.shop_photos
  for all using (shop_id = (select public.my_shop_id()))
  with check (shop_id = (select public.my_shop_id()));

-- Users can't change their own role, billing fields or review counts from the app.
revoke update on public.profiles from anon, authenticated;
grant update (full_name, phone) on public.profiles to authenticated;
revoke insert, update on public.shops from anon, authenticated;
-- A new shop starts hidden: going live is an update, which checks it has
-- something to book (shops_ready_to_go_live).
grant insert (owner_id, name, slug, about, address, area, latitude, longitude, phone, instagram)
  on public.shops to authenticated;
grant update (name, slug, about, address, area, latitude, longitude, phone, instagram, is_published,
              queue_enabled)
  on public.shops to authenticated;
-- The review counts on barbers are the database's too.
revoke insert, update on public.barbers from anon, authenticated;
grant insert (id, shop_id, name, about, is_active, sort_order) on public.barbers to authenticated;
grant update (name, about, is_active, sort_order) on public.barbers to authenticated;
revoke insert, update, delete on public.bookings from anon, authenticated;
revoke insert, update, delete on public.shop_closures from anon, authenticated;
-- Who is waiting is between the customer and the shop: only the waiting
-- list functions read or write it.
revoke all on public.waitlist from anon, authenticated;
-- The same for the walk-in queue: customers see counts and their own place,
-- and only the shop sees names.
revoke all on public.queue_entries from anon, authenticated;
-- Reviews are written through rate_booking and reply_to_review, and read
-- without who wrote them: an account id would tie one person's reviews
-- together across shops.
revoke all on public.reviews from anon, authenticated;
grant select (booking_id, shop_id, barber_id, rating, comment, first_name, reply, replied_at, created_at, updated_at)
  on public.reviews to anon, authenticated;
-- A photo's files and shop never change: a new photo is a new row. Its
-- place in the order is set by shop_photos_check on the way in.
revoke insert, update on public.shop_photos from anon, authenticated;
grant insert (shop_id, barber_id, caption, path, thumb_path, width, height) on public.shop_photos to authenticated;
grant update (barber_id, caption, sort_order) on public.shop_photos to authenticated;

-- Finding a barber ----------------------------------------------------------

-- Each shop's hours today by its own clock, for a list of shops: the first
-- barber in to the last one out, leaving out barbers with the whole day off.
-- Nulls when nobody is in, or the shop is closed for the day. Breaks are
-- ignored. One row per shop the caller can see (live, or their own).
-- find_shops and my_shops ask once for their whole page: one call per shop
-- took about a tenth of the shop list's time (see README, "How many users it
-- handles"). plpgsql with a generic plan, so a connection plans it once, and
-- each day's bounds are worked out before the bookings lookup: as one SQL
-- query the planner read every booking the barbers ever had.
create function public.shops_hours_today(p_shop_ids uuid[])
returns table (shop_id uuid, opens_today time, closes_today time)
language plpgsql
stable
security definer
set search_path = public
set plan_cache_mode = force_generic_plan
as $$
#variable_conflict use_column
begin
  return query
  select sh.id, h.opens_today, h.closes_today
  from (
    select s.id, s.time_zone as tz, (now() at time zone s.time_zone)::date as day
    from shops s
    where s.id = any(p_shop_ids) and (public.shop_is_live(s) or s.owner_id = (select auth.uid()))
  ) sh
  cross join lateral (
    select min(wh.opens_at) as opens_today, max(wh.closes_at) as closes_today
    from barbers b
    join working_hours wh on wh.barber_id = b.id and wh.weekday = extract(dow from sh.day)::int
    where b.shop_id = sh.id
      and b.is_active
      and not exists (select 1 from shop_closures c where c.shop_id = sh.id and c.day = sh.day)
      and b.id not in (
        select bk.barber_id from bookings bk
        where bk.shop_id = sh.id
          and bk.starts_at >= sh.day::timestamp at time zone sh.tz
          and bk.starts_at < (sh.day + 1)::timestamp at time zone sh.tz
          and bk.is_block
          and bk.status = 'confirmed'
          and bk.ends_at - bk.starts_at >= interval '24 hours'
      )
  ) h;
end;
$$;
-- Only shop_hours_today, find_shops and my_shops use it.
revoke execute on function public.shops_hours_today(uuid[]) from public, anon, authenticated;

-- One shop's hours today, for its page: nulls when the caller can't see it.
create function public.shop_hours_today(p_shop_id uuid)
returns table (opens_today time, closes_today time)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  return query
  select h.opens_today, h.closes_today
  from (values (1)) one (x)
  left join public.shops_hours_today(array[p_shop_id]) h on true;
end;
$$;

-- When someone wanting a cut soon could get one, for each of a list of
-- shops: the earliest free start for the shop's shortest service with any
-- barber, today by the shop's clock or else tomorrow. No row when neither
-- day has a free time, or the caller can't see the shop. It gives the same
-- answer as the earliest of available_slots (booking_test.sql checks), but
-- rather than trying every start time it only tries the few that can be
-- first: free times sit on a 15-minute grid from opening, so the first one
-- is the first grid time after now, or the first after one of the barber's
-- bookings ends. find_shops and my_shops ask once for their whole page, and
-- tomorrow is only worked out for the shops with nothing left today: one
-- call per shop took nearly half the shop list's time (see README, "How
-- many users it handles"). A generic plan, so a connection plans the query
-- once.
create function public.shops_next_free(p_shop_ids uuid[])
returns table (shop_id uuid, next_free_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
set plan_cache_mode = force_generic_plan
as $$
#variable_conflict use_column
declare
  v_left uuid[] := p_shop_ids;
  v_found record;
begin
  -- Today, then tomorrow for the rest. Both are well inside the booking horizon.
  for i in 0..1 loop
    exit when cardinality(v_left) = 0;
    for v_found in
      with shop as (
        select s.id, s.time_zone as tz, (now() at time zone s.time_zone)::date + i as day,
               (select v.duration_min from services v where v.shop_id = s.id and v.is_active
                order by v.duration_min, v.sort_order, v.id limit 1) as minutes
        from shops s
        where s.id = any(v_left) and (public.shop_is_live(s) or s.owner_id = (select auth.uid()))
      ),
      hours as (
        select sh.id as shop_id, sh.minutes, w.barber_id,
               (sh.day + w.opens_at) at time zone sh.tz as opens,
               (sh.day + w.closes_at) at time zone sh.tz as closes
        from shop sh
        -- Offset 0 keeps this a lookup of each shop's own barbers, where the
        -- planner would otherwise read every barber on the platform.
        cross join lateral (
          select b.id as barber_id, wh.opens_at, wh.closes_at
          from barbers b
          join working_hours wh on wh.barber_id = b.id and wh.weekday = extract(dow from sh.day)::int
          where b.shop_id = sh.id and b.is_active
          offset 0
        ) w
        where sh.minutes is not null
          and not exists (select 1 from shop_closures c where c.shop_id = sh.id and c.day = sh.day)
      ),
      taken as materialized (
        -- Bookings and blocks are at most a day long, so anything in the way
        -- started after the day before began; and only one that hasn't ended
        -- yet can be in the way of a time from now on.
        select bk.shop_id, bk.barber_id, bk.starts_at, bk.ends_at
        from shop sh
        join bookings bk on bk.shop_id = sh.id
          and bk.status <> 'cancelled'
          and bk.starts_at > (sh.day - 1)::timestamp at time zone sh.tz
          and bk.starts_at < (sh.day + 1)::timestamp at time zone sh.tz
          and bk.ends_at > now()
      ),
      tries as materialized (
        -- Each point rounded up to the grid; the microsecond keeps a grid time
        -- that is exactly now out, as available_slots does.
        select p.shop_id, p.barber_id, p.closes, g.at, g.at + make_interval(mins => p.minutes) as done
        from (
          select h.shop_id, h.barber_id, h.opens, h.closes, h.minutes,
                 greatest(h.opens, now() + interval '1 microsecond') as at
          from hours h
          union all
          select h.shop_id, h.barber_id, h.opens, h.closes, h.minutes,
                 greatest(t.ends_at, h.opens, now() + interval '1 microsecond')
          from hours h
          join taken t on t.shop_id = h.shop_id and t.barber_id = h.barber_id
          where t.ends_at > h.opens and t.ends_at < h.closes
        ) p
        cross join lateral (
          select date_bin('15 minutes', p.at + interval '15 minutes' - interval '1 microsecond', p.opens) as at
        ) g
      )
      select tr.shop_id, min(tr.at) as at
      from tries tr
      where tr.done <= tr.closes
        and not exists (
          select 1 from taken t
          where t.shop_id = tr.shop_id and t.barber_id = tr.barber_id
            and t.starts_at < tr.done and t.ends_at > tr.at
        )
      group by tr.shop_id
    loop
      shop_id := v_found.shop_id;
      next_free_at := v_found.at;
      return next;
      v_left := array_remove(v_left, v_found.shop_id);
    end loop;
  end loop;
end;
$$;
-- Only find_shops and my_shops use it.
revoke execute on function public.shops_next_free(uuid[]) from public, anon, authenticated;

-- How far apart two points are in km, over the earth's surface (the
-- haversine formula on a round earth: well within the 100 m the app shows).
-- Plain SQL, so it needs no extension, and with no settings or strictness,
-- so Postgres inlines it into find_shops. Null when either point is. The
-- atan2 form, as asin fails on a rounding error past 1 for points on
-- opposite sides of the earth; src/lib/distance.ts does the same.
create function public.km_between(p_lat1 double precision, p_lng1 double precision,
                                  p_lat2 double precision, p_lng2 double precision)
returns double precision
language sql
immutable
parallel safe
as $$
  select 2 * 6371.0088 * atan2(
    sqrt(sin(radians(p_lat2 - p_lat1) / 2) ^ 2
         + cos(radians(p_lat1)) * cos(radians(p_lat2)) * sin(radians(p_lng2 - p_lng1) / 2) ^ 2),
    sqrt(greatest(0, 1 - sin(radians(p_lat2 - p_lat1) / 2) ^ 2
                    - cos(radians(p_lat1)) * cos(radians(p_lat2)) * sin(radians(p_lng2 - p_lng1) / 2) ^ 2)));
$$;
revoke execute on function public.km_between(double precision, double precision, double precision, double precision)
  from public, anon, authenticated;

-- The customer's shop list: live shops whose name, area or address contains
-- the search, a page at a time, with each shop's lowest price, number of
-- chairs, today's hours (first barber in to last one out, in the shop's
-- time zone; breaks and blocked time are not counted, and both are null
-- when nobody works today), its next free time, and how many reviews it
-- has with their average to one decimal (null without any), and its first
-- photo's thumbnail for the card (null without photos). Sending every
-- shop with all its services and barbers came to 570 KB for 1,000 shops
-- (e2e/load).
-- Given the customer's position (Near me), each shop also says how far it
-- is, and the list goes nearest first, with shops that haven't set their
-- location after the rest by name. A position off the map, or half of one,
-- is left out. The position is only used here: nothing stores it. This
-- measures every live shop, which takes about a millisecond for a thousand;
-- the README says what to switch to for tens of thousands.
-- The page is picked first, then today's hours and the next free time are
-- worked out for the whole page in one call each. plpgsql with generic
-- plans, so a connection plans each query once: as one SQL query it was
-- planned on every call, about half a millisecond each time. To add a
-- column, add it to the returns table and to the last select, in the same
-- place in both.
create function public.find_shops(
  p_search text default null,
  p_area text default null,
  p_limit int default 20,
  p_offset int default 0,
  p_lat double precision default null,
  p_lng double precision default null
)
returns table (
  id uuid,
  name text,
  slug text,
  area text,
  address text,
  about text,
  from_price numeric,
  barber_count int,
  opens_today time,
  closes_today time,
  next_free_at timestamptz,
  rating_count int,
  rating_avg numeric,
  distance_km double precision,
  -- Where the shop is, so Directions from its page go there before the rest of the page loads.
  latitude double precision,
  longitude double precision,
  -- How many are waiting in its walk-in queue today; null when it has none.
  queue_waiting int,
  -- Its first photo's thumbnail (a path in the shop-photos bucket); null without photos.
  photo_thumb text
)
language plpgsql
stable
security definer
set search_path = public
set plan_cache_mode = force_generic_plan
as $$
#variable_conflict use_column
declare
  v_search text := lower(trim(p_search));
  v_area text := lower(trim(p_area));
  v_near boolean := coalesce(p_lat between -90 and 90 and p_lng between -180 and 180, false);
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_page uuid[];
begin
  -- With nothing to narrow or measure by, the page comes straight off
  -- shops_name_idx in name order. Otherwise every live shop is looked at:
  -- nearest first given a position (without one every distance is null, so
  -- the order is by name either way). The id last keeps the pages from
  -- overlapping.
  if coalesce(v_search, '') = '' and coalesce(v_area, '') = '' and not v_near then
    v_page := array(
      select s.id
      from shops s
      where public.shop_is_live(s)
      order by lower(s.name), s.id
      limit v_limit offset v_offset
    );
  else
    v_page := array(
      select s.id
      from shops s
      where public.shop_is_live(s)
        and (coalesce(v_area, '') = '' or lower(s.area) = v_area)
        and (
          coalesce(v_search, '') = ''
          or strpos(lower(s.name || ' ' || s.area || ' ' || coalesce(s.address, '')), v_search) > 0
        )
      order by case when v_near then public.km_between(p_lat, p_lng, s.latitude, s.longitude) end nulls last,
               lower(s.name), s.id
      limit v_limit offset v_offset
    );
  end if;

  return query
  select s.id, s.name, s.slug, s.area, s.address, s.about,
         (select min(v.price) from services v where v.shop_id = s.id and v.is_active),
         (select count(*)::int from barbers b where b.shop_id = s.id and b.is_active),
         h.opens_today, h.closes_today, f.next_free_at,
         s.rating_count, round(s.rating_sum::numeric / nullif(s.rating_count, 0), 1),
         case when v_near then public.km_between(p_lat, p_lng, s.latitude, s.longitude) end,
         s.latitude, s.longitude,
         case when s.queue_enabled then q.waiting end,
         ph.thumb_path
  from unnest(v_page) with ordinality as page (id, n)
  join shops s on s.id = page.id
  left join public.shops_hours_today(v_page) h on h.shop_id = s.id
  left join public.shops_next_free(v_page) f on f.shop_id = s.id
  -- One lookup of queue_entries_shop_day_idx per shop, only for queue shops.
  left join lateral (
    select count(*)::int as waiting
    from queue_entries e
    where s.queue_enabled and e.shop_id = s.id and e.state = 'waiting'
      and e.day = (now() at time zone s.time_zone)::date
  ) q on true
  -- One lookup of shop_photos_shop_order_idx per shop.
  left join lateral (
    select p.thumb_path
    from shop_photos p
    where p.shop_id = s.id
    order by p.sort_order, p.created_at, p.id
    limit 1
  ) ph on true
  order by page.n;
end;
$$;

-- What a booking link should say when the shop is hidden (paused, or its
-- trial ended): the shop's name and number, so customers can message it
-- instead of being told the shop doesn't exist. No row for an unknown link.
create function public.shop_public_status(p_slug text)
returns table (name text, phone text, is_live boolean)
language sql
stable
security definer
set search_path = public
as $$
  select s.name, s.phone, public.shop_is_live(s)
  from shops s
  where s.slug = p_slug;
$$;

-- Areas that have live shops, most shops first, for the area filter. Areas
-- are typed by barbers, so spellings that differ only in case count as one,
-- under the spelling most of them use (the first in order on a tie, as
-- mode() would pick). Each spelling is counted once by hashing rather than
-- sorting every shop; plpgsql, so a connection plans it once.
create function public.shop_areas()
returns table (area text, shops int)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  return query
  select a.area, a.shops
  from (
    select distinct on (g.key) g.key, g.area, (sum(g.n) over (partition by g.key))::int as shops
    from (
      select lower(s.area) as key, s.area, count(*) as n
      from shops s
      where public.shop_is_live(s)
      group by lower(s.area), s.area
    ) g
    order by g.key, g.n desc, g.area
  ) a
  order by a.shops desc, a.key;
end;
$$;

-- Booking rules ------------------------------------------------------------

-- How far ahead customers can book, and how many upcoming bookings one
-- customer may hold at one shop (stops a single account blocking a day).
create function public.booking_horizon_days() returns int language sql immutable as $$ select 60 $$;
create function public.max_upcoming_per_shop() returns int language sql immutable as $$ select 4 $$;

-- Changes to one shop's bookings happen one at a time. Two people taking
-- overlapping times at once otherwise deadlock on bookings_no_overlap, and
-- Postgres fails one of them after a second's wait, holding a connection all
-- the while. In a load test of 1,000 customers rushing one shop's Saturday,
-- 20 deadlocks backed up the connection pool until 957 of them got an error
-- instead of "that time was just taken"; with this lock, none did.
-- Held until the transaction ends.
create function public.lock_shop_diary(p_shop_id uuid)
returns void
language sql
as $$
  select pg_advisory_xact_lock(hashtextextended('shop-diary:' || p_shop_id, 0));
$$;
revoke execute on function public.lock_shop_diary(uuid) from public, anon, authenticated;

-- Free start times for a service on a given local day, per barber.
-- Slots start every 15 minutes inside each barber's working hours, skip
-- anything already booked, skip times that have passed, and stop at the
-- booking horizon. p_ignore_booking leaves one booking out of the taken
-- times, so a booking being moved doesn't block its own neighbouring slots.
-- find_shops runs this for every shop on a page, so it is plpgsql, which
-- keeps its plan between calls, and it looks up each barber's bookings for
-- the day once rather than once per start time. On the e2e/load data that
-- took a day's free times from 5 ms to under 0.5 ms.
create function public.available_slots(
  p_service_id uuid,
  p_day date,
  p_barber_id uuid default null,
  p_ignore_booking uuid default null
)
returns table (barber_id uuid, starts_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return query
  with ignored as (
    -- Only the caller's own booking, or one at their shop, so nobody can
    -- find out when someone else is booked.
    select bk.id from bookings bk
    where bk.id = p_ignore_booking
      and (bk.customer_id = auth.uid() or public.owns_shop(bk.shop_id))
  ),
  svc as (
    select s.id, s.shop_id, s.duration_min, sh.time_zone
    from services s
    join shops sh on sh.id = s.shop_id
    where s.id = p_service_id
      and s.is_active
      and (public.shop_is_live(sh) or sh.owner_id = auth.uid())
      and p_day <= (now() at time zone sh.time_zone)::date + public.booking_horizon_days()
      and not exists (select 1 from shop_closures c where c.shop_id = s.shop_id and c.day = p_day)
  ),
  candidates as (
    select distinct
           b.id as barber_id,
           t at time zone svc.time_zone as starts_at,
           svc.duration_min
    from svc
    join barbers b on b.shop_id = svc.shop_id and b.is_active
    join working_hours wh on wh.barber_id = b.id
      and wh.weekday = extract(dow from p_day)::int
    cross join lateral generate_series(
      p_day + wh.opens_at,
      p_day + wh.closes_at - make_interval(mins => svc.duration_min),
      interval '15 minutes'
    ) as t
    where (p_barber_id is null or b.id = p_barber_id)
  ),
  taken as materialized (
    -- Every start time ends by closing time, so only bookings that touch
    -- the day can be in the way.
    select bk.barber_id, tstzrange(bk.starts_at, bk.ends_at) as during
    from svc
    join barbers b on b.shop_id = svc.shop_id and b.is_active
    join bookings bk on bk.barber_id = b.id
    where (p_barber_id is null or b.id = p_barber_id)
      and bk.status <> 'cancelled'
      and bk.id is distinct from (select id from ignored)
      and tstzrange(bk.starts_at, bk.ends_at)
          && tstzrange(p_day::timestamp at time zone svc.time_zone, (p_day + 1)::timestamp at time zone svc.time_zone)
  )
  select c.barber_id, c.starts_at
  from candidates c
  where c.starts_at > now()
    and not exists (
      select 1 from taken tk
      where tk.barber_id = c.barber_id
        and tk.during && tstzrange(c.starts_at, c.starts_at + make_interval(mins => c.duration_min))
    )
  order by c.starts_at, c.barber_id;
end;
$$;

-- Book a slot. With no barber given, picks the free barber with the fewest
-- bookings that day so work is shared across chairs.
create function public.book_appointment(
  p_service_id uuid,
  p_starts_at timestamptz,
  p_barber_id uuid default null,
  p_note text default null
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_service services;
  v_tz text;
  v_day date;
  v_barber uuid;
  v_booking bookings;
begin
  if v_uid is null then
    raise exception 'Please sign in to book.' using errcode = '28000';
  end if;

  select s.* into v_service from services s where s.id = p_service_id;
  if not found then
    raise exception 'This service is no longer available.' using errcode = 'P0002';
  end if;

  if length(p_note) > 280 then
    raise exception 'Please keep your note under 280 characters.' using errcode = '22001';
  end if;

  perform public.lock_shop_diary(v_service.shop_id);

  if (
    select count(*) from bookings
    where customer_id = v_uid
      and shop_id = v_service.shop_id
      and status = 'confirmed'
      and starts_at > now()
  ) >= public.max_upcoming_per_shop() then
    raise exception 'You already have % upcoming bookings here. Cancel one to book another.',
      public.max_upcoming_per_shop() using errcode = 'P0001';
  end if;

  select time_zone into v_tz from shops where id = v_service.shop_id;
  v_day := (p_starts_at at time zone v_tz)::date;

  select a.barber_id into v_barber
  from public.available_slots(p_service_id, v_day, p_barber_id) a
  where a.starts_at = p_starts_at
  order by (
    select count(*) from bookings bk
    where bk.barber_id = a.barber_id
      and bk.status <> 'cancelled'
      and tstzrange(bk.starts_at, bk.ends_at)
          && tstzrange(v_day::timestamp at time zone v_tz, (v_day + 1)::timestamp at time zone v_tz)
  ), a.barber_id
  limit 1;

  if v_barber is null then
    raise exception 'Sorry, that time was just taken. Please pick another.' using errcode = 'P0001';
  end if;

  begin
    insert into bookings (
      shop_id, barber_id, service_id, customer_id, service_name, price,
      starts_at, ends_at, customer_note, customer_changed_at, customer_change
    ) values (
      v_service.shop_id, v_barber, v_service.id, v_uid, v_service.name, v_service.price,
      p_starts_at, p_starts_at + make_interval(mins => v_service.duration_min),
      nullif(trim(p_note), ''), clock_timestamp(), 'booked'
    )
    returning * into v_booking;
  exception when exclusion_violation then
    raise exception 'Sorry, that time was just taken. Please pick another.' using errcode = 'P0001';
  end;

  -- They have their time that day, so they are no longer waiting for one.
  delete from waitlist where customer_id = v_uid and shop_id = v_service.shop_id and day = v_day;
  -- A time here today is their turn, so they leave its walk-in queue (see join_queue).
  update queue_entries set state = 'gone', gone_reason = 'left', gone_at = now()
  where customer_id = v_uid and day = v_day and shop_id = v_service.shop_id and state <> 'gone'
    and v_day = (now() at time zone v_tz)::date;

  return v_booking;
end;
$$;

-- Change a booking's status. Customers may cancel their own upcoming
-- bookings. Shop owners may cancel, and once the appointment has started,
-- mark it done or a no-show (or undo that by confirming it again).
create function public.set_booking_status(
  p_booking_id uuid,
  p_status public.booking_status
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking bookings;
  v_by_customer boolean := false;
begin
  select * into v_booking from bookings where id = p_booking_id;
  if not found then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;

  if public.owns_shop(v_booking.shop_id) then
    if p_status in ('completed', 'no_show') and v_booking.starts_at > now() then
      raise exception 'You can mark this once the appointment has started.' using errcode = '42501';
    end if;
  elsif v_booking.customer_id = auth.uid() then
    if p_status <> 'cancelled' or v_booking.status <> 'confirmed' or v_booking.starts_at <= now() then
      raise exception 'You can only cancel an upcoming booking.' using errcode = '42501';
    end if;
    v_by_customer := true;
  else
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;

  perform public.lock_shop_diary(v_booking.shop_id);
  begin
    update bookings set
      status = p_status,
      customer_changed_at = case when v_by_customer then clock_timestamp() else customer_changed_at end,
      customer_change = case when v_by_customer then 'cancelled' else customer_change end
    where id = p_booking_id
    returning * into v_booking;
  exception when exclusion_violation then
    raise exception 'That time has been booked by someone else since.' using errcode = 'P0001';
  end;
  return v_booking;
end;
$$;

-- The shop owner WhatsApps a customer a reminder and records it here, so the
-- other phones in the shop don't send a second one. p_starts_at is the time
-- the message named: a booking moved since then (even while this waits on it)
-- is left unreminded, so the new time still gets one. p_reminded false takes
-- a reminder back, when the message never went out. Only for a booking that
-- is still to come.
create function public.mark_booking_reminded(
  p_booking_id uuid,
  p_starts_at timestamptz,
  p_reminded boolean default true
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking bookings;
begin
  select * into v_booking from bookings where id = p_booking_id;
  if not found or v_booking.is_block or not public.owns_shop(v_booking.shop_id) then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;

  -- Checked in the update itself, so a cancel or move that commits first wins.
  update bookings set reminded_at = case when p_reminded then now() end
  where id = p_booking_id and status = 'confirmed' and starts_at > now() and starts_at = p_starts_at
  returning * into v_booking;
  if not found then
    select * into v_booking from bookings where id = p_booking_id;
    if v_booking.status = 'confirmed' and v_booking.starts_at > now() then
      raise exception 'This booking has changed. Check the new time.' using errcode = '42501';
    end if;
    raise exception 'You can only remind a customer about an upcoming booking.' using errcode = '42501';
  end if;
  return v_booking;
end;
$$;

-- Move a booking to another free time instead of cancelling and booking
-- again, so it keeps its place in the diary, its note and its price.
-- Customers move their own upcoming bookings, and the shop owner moves any of
-- the shop's (a customer who calls to come later, or a walk-in booked ahead),
-- so the customer's booking stays theirs. The new time follows the same rules as
-- booking, except that the booking's own time doesn't count as taken, so
-- moving 15 minutes later works. With no barber given it stays with the
-- same barber if they are free, else goes to whoever is least busy that day.
create function public.reschedule_booking(
  p_booking_id uuid,
  p_starts_at timestamptz,
  p_barber_id uuid default null
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking bookings;
  v_service services;
  v_tz text;
  v_day date;
  v_barber uuid;
  v_by_customer boolean;
begin
  -- Lock before reading, so nobody cancels or moves it in between.
  perform public.lock_shop_diary(shop_id) from bookings where id = p_booking_id;
  select * into v_booking from bookings where id = p_booking_id;
  if not found or v_booking.is_block then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;

  if v_booking.customer_id is distinct from auth.uid() and not public.owns_shop(v_booking.shop_id) then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;
  -- As in set_booking_status, the owner counts as the shop.
  v_by_customer := not public.owns_shop(v_booking.shop_id);
  if v_booking.status <> 'confirmed' or v_booking.starts_at <= now() then
    raise exception 'You can only change an upcoming booking.' using errcode = '42501';
  end if;

  select * into v_service from services where id = v_booking.service_id and is_active;
  if not found then
    raise exception 'This service is no longer available.' using errcode = 'P0002';
  end if;

  select time_zone into v_tz from shops where id = v_booking.shop_id;
  v_day := (p_starts_at at time zone v_tz)::date;

  select a.barber_id into v_barber
  from public.available_slots(v_service.id, v_day, p_barber_id, v_booking.id) a
  where a.starts_at = p_starts_at
  order by
    a.barber_id = v_booking.barber_id desc,
    (
      select count(*) from bookings bk
      where bk.barber_id = a.barber_id
        and bk.status <> 'cancelled'
        and tstzrange(bk.starts_at, bk.ends_at)
            && tstzrange(v_day::timestamp at time zone v_tz, (v_day + 1)::timestamp at time zone v_tz)
    ),
    a.barber_id
  limit 1;

  if v_barber is null then
    raise exception 'Sorry, that time was just taken. Please pick another.' using errcode = 'P0001';
  end if;

  begin
    update bookings set
      barber_id = v_barber,
      starts_at = p_starts_at,
      ends_at = p_starts_at + make_interval(mins => v_service.duration_min),
      -- Any reminder named the old time.
      reminded_at = null,
      customer_changed_at = case when v_by_customer then clock_timestamp() else customer_changed_at end,
      customer_change = case when v_by_customer then 'moved' else customer_change end
    where id = v_booking.id
    returning * into v_booking;
  exception when exclusion_violation then
    raise exception 'Sorry, that time was just taken. Please pick another.' using errcode = 'P0001';
  end;

  -- Moved into a day they were waiting on: as good as booking it.
  delete from waitlist
  where customer_id = v_booking.customer_id and shop_id = v_booking.shop_id and day = v_day;
  -- And moved to later today, out of the shop's walk-in queue, as booking it would.
  update queue_entries set state = 'gone', gone_reason = 'left', gone_at = now()
  where customer_id = v_booking.customer_id and day = v_day and shop_id = v_booking.shop_id and state <> 'gone'
    and v_day = (now() at time zone v_tz)::date;

  return v_booking;
end;
$$;

-- Replace a barber's whole week in one go, so a failed save never leaves
-- them with no hours. p_hours: [{"weekday": 1, "opens_at": "10:00", "closes_at": "20:00"}, ...]
create function public.set_barber_hours(p_barber_id uuid, p_hours jsonb)
returns setof public.working_hours
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from barbers b where b.id = p_barber_id and public.owns_shop(b.shop_id)
  ) then
    raise exception 'Barber not found.' using errcode = 'P0002';
  end if;

  delete from working_hours where barber_id = p_barber_id;
  begin
    insert into working_hours (barber_id, weekday, opens_at, closes_at)
    select p_barber_id, (h ->> 'weekday')::smallint, (h ->> 'opens_at')::time, (h ->> 'closes_at')::time
    from jsonb_array_elements(coalesce(p_hours, '[]'::jsonb)) h;
  exception
    when exclusion_violation then
      raise exception 'Some of those hours overlap on the same day.' using errcode = 'P0001';
    when check_violation then
      raise exception 'Closing time must be after opening time.' using errcode = 'P0001';
  end;

  return query select * from working_hours where barber_id = p_barber_id order by weekday, opens_at;
end;
$$;

-- Shop owners add bookings that came in another way (walk-in, WhatsApp,
-- phone) or block time, so online customers can't take those slots.
-- Times are the shop's local day and clock time. Working hours are not
-- enforced here: the owner may squeeze someone in.
create function public.add_shop_booking(
  p_barber_id uuid,
  p_day date,
  p_time time,
  p_duration_min int default null,
  p_service_id uuid default null,
  p_guest_name text default null,
  p_guest_phone text default null,
  p_note text default null,
  p_is_block boolean default false
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop shops;
  v_service services;
  v_minutes int;
  v_starts timestamptz;
  v_booking bookings;
begin
  select s.* into v_shop
  from barbers b join shops s on s.id = b.shop_id
  where b.id = p_barber_id and s.owner_id = auth.uid();
  if not found then
    raise exception 'Barber not found.' using errcode = 'P0002';
  end if;

  if p_service_id is not null then
    select * into v_service from services where id = p_service_id and shop_id = v_shop.id;
    if not found then
      raise exception 'Service not found.' using errcode = 'P0002';
    end if;
  end if;

  v_minutes := coalesce(p_duration_min, v_service.duration_min);
  if v_minutes is null or v_minutes < 5 or v_minutes > (case when p_is_block then 1440 else 720 end) then
    raise exception 'Pick a service, or a length between 5 minutes and 12 hours (a whole day for blocks).'
      using errcode = '22023';
  end if;
  if not p_is_block and nullif(trim(p_guest_name), '') is null then
    raise exception 'Add the customer''s name.' using errcode = '22023';
  end if;

  v_starts := (p_day + p_time) at time zone v_shop.time_zone;

  perform public.lock_shop_diary(v_shop.id);
  begin
    insert into bookings (
      shop_id, barber_id, service_id, guest_name, guest_phone, is_block,
      service_name, price, starts_at, ends_at, customer_note
    ) values (
      v_shop.id, p_barber_id, v_service.id,
      case when p_is_block then null else nullif(trim(p_guest_name), '') end,
      case when p_is_block then null else nullif(trim(p_guest_phone), '') end,
      p_is_block,
      case when p_is_block then coalesce(left(nullif(trim(p_note), ''), 80), 'Blocked')
           else coalesce(v_service.name, 'Appointment') end,
      case when p_is_block then 0 else coalesce(v_service.price, 0) end,
      v_starts, v_starts + make_interval(mins => v_minutes),
      case when p_is_block then null else nullif(trim(p_note), '') end
    )
    returning * into v_booking;
  exception when exclusion_violation then
    raise exception 'That barber already has a booking at that time.' using errcode = 'P0001';
  end;

  -- Someone waiting for a time that day, put in by hand after a WhatsApp:
  -- their number finds them (in the one form shop_customers compares), and
  -- they have their time now. Only that day's few requests are looked at.
  if v_booking.guest_phone is not null then
    delete from waitlist w using profiles p
    where w.shop_id = v_shop.id and w.day = p_day and p.id = w.customer_id
      and nullif(regexp_replace(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), '^0', '60'), '')
          = nullif(regexp_replace(regexp_replace(v_booking.guest_phone, '\D', '', 'g'), '^0', '60'), '');
  end if;

  return v_booking;
end;
$$;

-- Close the whole shop for a run of days, like Hari Raya. It refuses while
-- customers are still to come on any of them, so nobody turns up to a
-- locked door. Barbers' own blocks are left as they are.
create function public.close_shop_days(p_from date, p_days int, p_reason text default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop shops;
  v_today date;
  v_count int;
  v_first timestamptz;
begin
  select * into v_shop from shops where owner_id = auth.uid();
  if not found then
    raise exception 'Set up your shop first.' using errcode = 'P0002';
  end if;
  if p_days is null or p_days < 1 or p_days > 31 then
    raise exception 'Pick between 1 and 31 days.' using errcode = '22023';
  end if;
  v_today := (now() at time zone v_shop.time_zone)::date;
  if p_from is null or p_from < v_today or p_from + p_days - 1 > v_today + public.booking_horizon_days() then
    raise exception 'Pick days from today up to 60 days ahead.' using errcode = '22023';
  end if;

  perform public.lock_shop_diary(v_shop.id);
  -- Customers already served today don't count, only those still to come.
  select count(*), min(starts_at) into v_count, v_first
  from bookings
  where shop_id = v_shop.id
    and not is_block
    and status = 'confirmed'
    and ends_at > now()
    and starts_at < (p_from + p_days)::timestamp at time zone v_shop.time_zone
    and ends_at > p_from::timestamp at time zone v_shop.time_zone;
  -- How many and the first day (on the shop's clock), which the app puts in
  -- its own words; the rest reads as it is for anyone calling this directly.
  if v_count > 0 then
    raise exception 'There are bookings on those days (%, the first on %). Cancel them first (and let the customers know), then close the shop.',
      v_count, to_char(greatest(v_first at time zone v_shop.time_zone, p_from::timestamp), 'YYYY-MM-DD')
      using errcode = 'P0001';
  end if;

  insert into shop_closures (shop_id, day, reason)
  select v_shop.id, d::date, left(nullif(trim(p_reason), ''), 80)
  from generate_series(p_from, p_from + p_days - 1, interval '1 day') as d
  on conflict (shop_id, day) do update set reason = excluded.reason;

  return p_days;
end;
$$;

-- Undo a closure. Returns how many closed days were opened again.
create function public.reopen_shop_days(p_from date, p_days int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_id uuid := public.my_shop_id();
  v_count int;
begin
  if v_shop_id is null then
    raise exception 'Set up your shop first.' using errcode = 'P0002';
  end if;
  perform public.lock_shop_diary(v_shop_id);
  delete from shop_closures
  where shop_id = v_shop_id and day >= p_from and day < p_from + greatest(p_days, 0);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Days in a range the booking page should show as closed: days the owner
-- closed the shop, and days everyone who works that weekday has the whole
-- day off. Then, with barber_id, each barber's own whole days off on the
-- other days, so the page shows that barber off rather than fully booked
-- (where waiting for a time could never work). Only the owner sees the
-- reason. is_closure marks the first kind, which Reopen undoes.
-- plpgsql so that each connection plans the query once: every shop page
-- asks for it, and as plain SQL planning it took ten times as long as
-- running it (see README, "How many users it handles").
create function public.shop_closed_days(p_shop_id uuid, p_from date, p_to date)
returns table (day date, reason text, is_closure boolean, barber_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return query
  with shop as (
    select sh.id, sh.time_zone, sh.owner_id = (select auth.uid()) as mine,
           least(p_to, p_from + 90) as last_day
    from shops sh
    where sh.id = p_shop_id and (public.shop_is_live(sh) or sh.owner_id = (select auth.uid()))
  ),
  off as (
    -- Each active barber's whole days off, on days the shop isn't closed.
    select (bk.starts_at at time zone shop.time_zone)::date as day, bk.barber_id,
           min(bk.service_name) as reason
    from bookings bk
    join shop on bk.shop_id = shop.id
    join barbers b on b.id = bk.barber_id and b.is_active
    where bk.is_block
      and bk.status = 'confirmed'
      and bk.ends_at - bk.starts_at >= interval '24 hours'
      and bk.starts_at >= p_from::timestamp at time zone shop.time_zone
      and bk.starts_at < (shop.last_day + 1)::timestamp at time zone shop.time_zone
      and not exists (
        select 1 from shop_closures c
        where c.shop_id = shop.id and c.day = (bk.starts_at at time zone shop.time_zone)::date
      )
    group by 1, 2
  ),
  off_days as (
    -- A barber who never works that weekday is off anyway, so doesn't keep the day open.
    select o.day, min(o.reason) as reason,
           not exists (
             select 1
             from barbers b
             join shop on b.shop_id = shop.id
             where b.is_active
               and exists (select 1 from working_hours wh
                           where wh.barber_id = b.id and wh.weekday = extract(dow from o.day)::int)
               and not exists (select 1 from off x where x.day = o.day and x.barber_id = b.id)
           ) as all_off
    from off o
    group by o.day
  )
  select c.day, case when shop.mine then c.reason end, true, null::uuid
  from shop_closures c join shop on c.shop_id = shop.id
  where c.day between p_from and shop.last_day
  union all
  select d.day, case when shop.mine then d.reason end, false, null
  from off_days d, shop
  where d.all_off
  union all
  select o.day, case when shop.mine then o.reason end, false, o.barber_id
  from off o join off_days d on d.day = o.day and not d.all_off, shop
  order by 1, 4;
end;
$$;

-- The owner's takings for a run of days by the shop's clock (p_from to p_to,
-- both included, at most 93 days), with everything the Takings screen shows
-- in one answer: totals, the same totals for the period before, and
-- bookings by day, by start hour, by barber and by service. jsonb because
-- those are six differently shaped lists, and one call means one trip and
-- one scan.
-- The period before has the same number of days, except that a whole month
-- compares with the whole month before. While the period is still running,
-- the period before is only counted up to the same point, so a Monday
-- morning isn't measured against all of last week.
-- Money is each booking's own price from when it was booked; blocked time is
-- left out. Only the caller's own shop, read through bookings_shop_starts_idx
-- for both periods at once: for a shop with 30,000 bookings over two years
-- (among the e2e/load data), a week takes 2 ms and the longest, 93 days with
-- the 93 before, 15 ms.
create function public.shop_summary(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_shop shops;
  v_days int := p_to - p_from + 1;
  v_prev_from date;
  v_start timestamptz;
  v_end timestamptz;
  v_prev_start timestamptz;
  v_prev_until timestamptz;
begin
  select * into v_shop from shops where owner_id = auth.uid();
  if not found then
    raise exception 'Set up your shop first.' using errcode = 'P0002';
  end if;
  if v_days is null or v_days < 1 or v_days > 93 then
    raise exception 'Pick a period of up to 93 days.' using errcode = '22023';
  end if;

  if p_from = date_trunc('month', p_from)::date and p_to + 1 = (date_trunc('month', p_from) + interval '1 month')::date then
    v_prev_from := (p_from - interval '1 month')::date;
  else
    v_prev_from := p_from - v_days;
  end if;
  v_start := p_from::timestamp at time zone v_shop.time_zone;
  v_end := (p_to + 1)::timestamp at time zone v_shop.time_zone;
  v_prev_start := v_prev_from::timestamp at time zone v_shop.time_zone;
  -- As far into the period before as now is into this one, by the shop's clock.
  v_prev_until := least(
    v_start,
    (v_prev_from + ((now() at time zone v_shop.time_zone) - p_from::timestamp)) at time zone v_shop.time_zone
  );

  return (
    with b as materialized (
      select bk.barber_id, bk.service_name, bk.price, bk.status, bk.ends_at,
             bk.starts_at >= v_start as this_period,
             bk.starts_at at time zone v_shop.time_zone as local_start
      from bookings bk
      where bk.shop_id = v_shop.id
        and bk.starts_at >= v_prev_start
        and bk.starts_at < v_end
        and (bk.starts_at >= v_start or bk.starts_at < v_prev_until)
        and not bk.is_block
    ),
    now_b as (
      select * from b where this_period
    )
    select jsonb_build_object(
      'from', p_from,
      'to', p_to,
      'totals', (
        select jsonb_build_object(
          'done', count(*) filter (where status = 'completed'),
          'takings', coalesce(sum(price) filter (where status = 'completed'), 0),
          'no_shows', count(*) filter (where status = 'no_show'),
          'no_show_value', coalesce(sum(price) filter (where status = 'no_show'), 0),
          'cancelled', count(*) filter (where status = 'cancelled'),
          -- Still to come, or in the chair now.
          'to_come', count(*) filter (where status = 'confirmed' and ends_at > now()),
          'to_come_value', coalesce(sum(price) filter (where status = 'confirmed' and ends_at > now()), 0),
          -- Over, but nobody marked them done or a no-show.
          'unmarked', count(*) filter (where status = 'confirmed' and ends_at <= now()),
          'unmarked_value', coalesce(sum(price) filter (where status = 'confirmed' and ends_at <= now()), 0)
        )
        from now_b
      ),
      'previous', (
        select jsonb_build_object(
          'from', v_prev_from,
          'to', p_from - 1,
          'until', v_prev_until,
          'done', count(*) filter (where status = 'completed'),
          'takings', coalesce(sum(price) filter (where status = 'completed'), 0),
          'no_shows', count(*) filter (where status = 'no_show'),
          'no_show_value', coalesce(sum(price) filter (where status = 'no_show'), 0),
          'cancelled', count(*) filter (where status = 'cancelled')
        )
        from b where not this_period
      ),
      -- Every day of the period. Bookings are all but cancelled ones: the
      -- chair was taken, even by a no-show.
      'days', (
        select jsonb_agg(jsonb_build_object(
                 'day', d.day,
                 'bookings', coalesce(x.bookings, 0),
                 'done', coalesce(x.done, 0),
                 'takings', coalesce(x.takings, 0)
               ) order by d.day)
        from (select g::date as day from generate_series(p_from, p_to, interval '1 day') g) d
        left join (
          select local_start::date as day,
                 count(*) filter (where status <> 'cancelled') as bookings,
                 count(*) filter (where status = 'completed') as done,
                 sum(price) filter (where status = 'completed') as takings
          from now_b
          group by 1
        ) x on x.day = d.day
      ),
      'hours', (
        select coalesce(jsonb_agg(jsonb_build_object('hour', hour, 'bookings', bookings) order by hour), '[]')
        from (
          select extract(hour from local_start)::int as hour, count(*) as bookings
          from now_b
          where status <> 'cancelled'
          group by 1
        ) h
      ),
      -- Every barber working here now, even one with nothing booked (a week
      -- away is worth seeing), and anyone since marked away who did have
      -- bookings in the period.
      'barbers', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'barber_id', br.id,
                 'name', br.name,
                 'bookings', coalesce(x.bookings, 0),
                 'done', coalesce(x.done, 0),
                 'takings', coalesce(x.takings, 0),
                 'no_shows', coalesce(x.no_shows, 0)
               ) order by coalesce(x.takings, 0) desc, coalesce(x.done, 0) desc, br.sort_order, br.created_at, br.id),
               '[]')
        from barbers br
        left join (
          select barber_id,
                 count(*) filter (where status <> 'cancelled') as bookings,
                 count(*) filter (where status = 'completed') as done,
                 coalesce(sum(price) filter (where status = 'completed'), 0) as takings,
                 count(*) filter (where status = 'no_show') as no_shows
          from now_b
          group by barber_id
        ) x on x.barber_id = br.id
        where br.shop_id = v_shop.id
          and (br.is_active or x.bookings > 0)
      ),
      -- The five most done, by the name they were booked under.
      'services', (
        select coalesce(jsonb_agg(jsonb_build_object('name', name, 'done', done, 'takings', takings)
                                  order by done desc, takings desc, name), '[]')
        from (
          select service_name as name, count(*) as done, sum(price) as takings
          from now_b
          where status = 'completed'
          group by service_name
          order by count(*) desc, sum(price) desc, service_name
          limit 5
        ) s
      )
    )
  );
end;
$$;

-- The shop's customers -------------------------------------------------------

-- The owner's list of everyone who came in or booked in the last two years,
-- from what the shop already has: its own bookings and the names and numbers
-- given with them. Online customers are their account. Walk-in and WhatsApp
-- guests are one person per phone number, however it was typed (012-345 6789
-- and +60 12-345 6789 are the same), or per name when there is no number.
-- A guest added under the number on one of the shop's online customers'
-- profiles is that customer: regulars often WhatsApp first and book online
-- later. Blocked time, cancellations, deleted accounts and walk-ins added
-- with neither a name nor a number are left out: there is nobody to contact
-- or tell apart.
--
-- A visit is a day they had a cut: marked done, or still confirmed once it
-- started, since not every barber marks each cut done. Their usual gap is
-- the median of the days between visits, at least a week, or four weeks
-- after one visit. They are due for a cut once that gap has passed with
-- nothing booked, until three gaps (and at least 90 days) have gone by, when
-- they have most likely found another barber. Due customers come first,
-- longest overdue first, then everyone else by their last visit.
--
-- It is all worked out here in one pass over the shop's bookings, found
-- through bookings_shop_starts_idx: two years of a busy three-chair shop
-- (31,000 bookings, 3,800 customers, with 100,000 profiles on the platform)
-- took 100 to 120 ms on a test machine, and a shop with 3,000 bookings 25 to
-- 40 ms. total_count and due_count are for every customer the search
-- matches, not just the page. My shop's card gets the same two numbers from
-- shop_customer_counts below, without the list: change the two together
-- (booking_test.sql checks they agree).
create function public.shop_customers(
  p_search text default null,
  p_limit int default 30,
  p_offset int default 0
)
returns table (
  customer_key text,
  customer_id uuid,
  name text,
  phone text,
  visits int,
  no_shows int,
  last_visit_at timestamptz,
  next_booking_at timestamptz,
  usual_gap_days int,
  is_due boolean,
  total_count int,
  due_count int
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_shop shops;
  v_today date;
  v_search text := nullif(lower(trim(p_search)), '');
  v_digits text;
begin
  select * into v_shop from shops where owner_id = auth.uid();
  if not found then
    return;
  end if;
  v_today := (now() at time zone v_shop.time_zone)::date;
  -- Only something typed like a number looks at phone numbers, so "Ali 2"
  -- doesn't find everyone with a 2 in theirs.
  if v_search ~ '^[0-9 +()-]+$' then
    v_digits := nullif(regexp_replace(v_search, '\D', '', 'g'), '');
  end if;

  return query
  with scanned as (
    -- The bookings that are someone's, with a guest's number in one form.
    select b.customer_id, b.guest_name, b.guest_phone, b.starts_at, b.status, k.phone_key,
           -- What barber/new-booking.tsx saves for a walk-in added without a name.
           b.customer_id is null and lower(trim(b.guest_name)) = 'walk-in' as unnamed
    from bookings b
    cross join lateral (
      -- Digits only, with a leading 0 written as 60, as WhatsApp wants it
      -- (lib/phone.ts). Byte order sorts these fastest.
      select case when b.customer_id is null then
               nullif(regexp_replace(regexp_replace(coalesce(b.guest_phone, ''), '\D', '', 'g'), '^0', '60'), '')
             end collate "C" as phone_key
    ) k
    where b.shop_id = v_shop.id
      and b.starts_at >= now() - interval '2 years'
      and b.starts_at < now() + interval '1 year'
      and not b.is_block
      and b.status <> 'cancelled'
      -- What delete_my_account leaves behind: history, but nobody to contact.
      and (b.customer_id is not null or b.guest_name <> 'Deleted account')
  ),
  accounts as (
    -- The shop's online customers, each looked up by id. A plain join can
    -- hash every profile on the platform; offset 0 stops the planner
    -- turning this back into one.
    select c.customer_id, pr.full_name, pr.phone,
           nullif(regexp_replace(regexp_replace(coalesce(pr.phone, ''), '\D', '', 'g'), '^0', '60'), '')
             collate "C" as phone_key
    from (select distinct s.customer_id from scanned s where s.customer_id is not null) c
    cross join lateral (select x.full_name, x.phone from profiles x where x.id = c.customer_id offset 0) pr
  ),
  numbers as (
    -- Numbers that are one online customer's, not shared by two accounts.
    select a.phone_key, min(a.customer_id::text)::uuid as customer_id
    from accounts a
    where a.phone_key is not null
    group by a.phone_key
    having count(*) = 1
  ),
  walked as (
    -- Each booking in date order per person, with the days since their
    -- previous visit (null for the first, 0 for a second cut the same day).
    select o.customer_id, o.guest_key, s.guest_name, s.guest_phone, s.starts_at, s.status,
           s.customer_id is null and not s.unnamed as named_guest, v.visited, d.day,
           d.day - max(d.day) over (partition by o.customer_id, o.guest_key order by s.starts_at
                                    rows between unbounded preceding and 1 preceding) as gap
    from scanned s
    left join numbers n on s.customer_id is null and n.phone_key = s.phone_key
    cross join lateral (
      select coalesce(s.customer_id, n.customer_id) as customer_id,
             case when s.customer_id is null and n.customer_id is null then
               coalesce('p:' || s.phone_key, 'n:' || lower(regexp_replace(trim(s.guest_name), '\s+', ' ', 'g')))
             end collate "C" as guest_key
    ) o
    cross join lateral (
      select s.status = 'completed' or (s.status = 'confirmed' and s.starts_at <= now()) as visited
    ) v
    cross join lateral (
      select case when v.visited then (s.starts_at at time zone v_shop.time_zone)::date end as day
    ) d
    -- With no name and no number, every such walk-in would add up to one
    -- made-up regular.
    where not (s.unnamed and s.phone_key is null)
  ),
  people as (
    select w.customer_id, w.guest_key,
           -- The name a guest last gave (not 'Walk-in') and their number as
           -- last typed. Rows arrive in date order, so these need no sorting.
           (array_agg(w.guest_name order by w.starts_at) filter (where w.named_guest))
             [(count(*) filter (where w.named_guest))::int] as guest_name,
           (array_agg(w.guest_phone order by w.starts_at) filter (where w.guest_key like 'p:%'))
             [(count(*) filter (where w.guest_key like 'p:%'))::int] as guest_phone,
           (count(*) filter (where w.visited and (w.gap is null or w.gap > 0)))::int as visits,
           (count(*) filter (where w.status = 'no_show'))::int as no_shows,
           max(w.starts_at) filter (where w.visited) as last_visit_at,
           max(w.day) as last_day,
           min(w.starts_at) filter (where w.status = 'confirmed' and w.starts_at > now()) as next_booking_at,
           -- Exact halves round up, as in the demo (numeric rounds away from zero).
           round((percentile_cont(0.5) within group (order by w.gap) filter (where w.gap > 0))::numeric)::int as median_gap
    from walked w
    group by w.customer_id, w.guest_key
  ),
  judged as (
    select coalesce('c:' || p.customer_id, p.guest_key) as key, p.customer_id,
           coalesce(nullif(trim(a.full_name), ''), p.guest_name) as name,
           case when p.customer_id is null then p.guest_phone else a.phone end as phone,
           p.visits, p.no_shows, p.last_visit_at, p.next_booking_at,
           case when p.visits >= 2 then greatest(p.median_gap, 7) else 28 end as gap,
           p.last_day
    from people p
    left join accounts a on a.customer_id = p.customer_id
  ),
  found as (
    select j.*,
           j.last_day is not null and j.next_booking_at is null
             and v_today - j.last_day >= j.gap
             and v_today - j.last_day < greatest(3 * j.gap, 90) as due
    from judged j
    where v_search is null
       or strpos(lower(j.name), v_search) > 0
       or strpos(regexp_replace(regexp_replace(coalesce(j.phone, ''), '\D', '', 'g'), '^0', '60'), v_digits) > 0
  )
  select f.key, f.customer_id, f.name, f.phone, f.visits, f.no_shows, f.last_visit_at, f.next_booking_at,
         f.gap, f.due, (count(*) over ())::int, (count(*) filter (where f.due) over ())::int
  from found f
  order by f.due desc,
           case when f.due then v_today - f.last_day - f.gap end desc nulls last,
           f.last_visit_at desc nulls last,
           lower(f.name), f.key
  limit least(greatest(coalesce(p_limit, 30), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- Each profile's number in the one form shop_customers compares numbers in,
-- so a walk-in's number finds the online customer it belongs to in one
-- lookup (shop_customer_counts).
create index profiles_phone_key_idx on public.profiles
  ((nullif(regexp_replace(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), '^0', '60'), '') collate "C"))
  where phone is not null;

-- How many customers a shop has and how many are due for a cut: the
-- total_count and due_count shop_customers gives with no search, for My
-- shop's card, which needs nothing else. Same rules, less work: no names or
-- order, each guest number looked up once instead of every online
-- customer's profile, a visit day worked out once per booking, and the
-- median gap only for someone who could be due. On the e2e/load data (2,820
-- bookings, all online) that is 4 ms instead of 20; for a shop with 33,000
-- bookings in two years, a fifth of them walk-ins, 70 ms instead of 100.
-- JIT is off for it: on that shop, compiling the query took 600 ms, ten
-- times as long as running it.
create function public.shop_customer_counts(p_shop_id uuid)
returns table (total int, due int)
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_tz text;
  v_today date;
begin
  select s.time_zone into v_tz from shops s where s.id = p_shop_id;
  if not found then
    return;
  end if;
  v_today := (now() at time zone v_tz)::date;

  return query
  with scanned as materialized (
    -- The same bookings as shop_customers, with the day of each visit.
    select b.customer_id, b.guest_name, b.guest_phone, b.status, b.starts_at,
           case when b.status = 'completed' or (b.status = 'confirmed' and b.starts_at <= now())
                then (b.starts_at at time zone v_tz)::date end as day
    from bookings b
    where b.shop_id = p_shop_id
      and b.starts_at >= now() - interval '2 years'
      and b.starts_at < now() + interval '1 year'
      and not b.is_block
      and b.status <> 'cancelled'
      and (b.customer_id is not null or b.guest_name <> 'Deleted account')
  ),
  numbers as materialized (
    -- Each number guests gave as typed, in one form, and the one online
    -- customer of the shop with it on their profile, if there is exactly one.
    select g.guest_phone, k.phone_key, m.customer_id
    from (select distinct s.guest_phone from scanned s where s.customer_id is null and s.guest_phone is not null) g
    cross join lateral (
      select nullif(regexp_replace(regexp_replace(g.guest_phone, '\D', '', 'g'), '^0', '60'), '') collate "C" as phone_key
    ) k
    left join lateral (
      select min(p.id::text)::uuid as customer_id
      from profiles p
      where (nullif(regexp_replace(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), '^0', '60'), '') collate "C")
              = k.phone_key
        and p.phone is not null
        and exists (
          select 1 from bookings x
          where x.customer_id = p.id and x.shop_id = p_shop_id
            and x.starts_at >= now() - interval '2 years'
            and x.starts_at < now() + interval '1 year'
            and not x.is_block
            and x.status <> 'cancelled'
        )
      having count(*) = 1
    ) m on true
  ),
  people as (
    -- One row per person, keyed as in shop_customers.
    select bool_or(r.status = 'confirmed' and r.starts_at > now()) as booked,
           max(r.day) as last_day,
           array_agg(distinct r.day) filter (where r.day is not null) as days
    from (
      select coalesce(s.customer_id, n.customer_id, '00000000-0000-0000-0000-000000000000') as customer_id,
             case when s.customer_id is null and n.customer_id is null then
               coalesce('p:' || n.phone_key, 'n:' || lower(regexp_replace(trim(s.guest_name), '\s+', ' ', 'g')))
             else '' end collate "C" as guest_key,
             s.status, s.starts_at, s.day
      from scanned s
      left join numbers n on s.customer_id is null and n.guest_phone = s.guest_phone
      where not (s.customer_id is null and n.phone_key is null and lower(trim(s.guest_name)) = 'walk-in')
    ) r
    group by r.customer_id, r.guest_key
  )
  -- Due: nothing booked and their usual gap (at least a week) passed, but
  -- not three gaps or 90 days. One visit means a gap of four weeks.
  select count(*)::int,
         (count(*) filter (where
            not p.booked and v_today - p.last_day >= 7
            and case when cardinality(p.days) = 1 then v_today - p.last_day between 28 and 89
                else (select v_today - p.last_day >= x.gap and v_today - p.last_day < greatest(3 * x.gap, 90)
                      from (select greatest(round(percentile_cont(0.5) within group (order by p.days[i] - p.days[i - 1])::numeric)::int, 7) as gap
                            from generate_subscripts(p.days, 1) i
                            where i > 1) x)
                end))::int
  from people p;
end;
$$;
-- Only shop_cards uses it.
revoke execute on function public.shop_customer_counts(uuid) from public, anon, authenticated;

-- Everything My shop's cards show, in one answer: the totals shop_summary
-- gives for p_from to p_to (the app asks for this week), how many customers
-- and how many are due (shop_customer_counts), the review count and total
-- with the newest comment, and the days the shop is closed from today to 60
-- days ahead with the reason (the closures shop_closed_days gives). It was
-- four requests, one of them making the whole customer list to read two
-- numbers from it: on the e2e/load data they took 23 ms of database time
-- for each visit, now 4. Only the caller's own shop.
create function public.shop_cards(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_shop shops;
  v_days int := p_to - p_from + 1;
  v_start timestamptz;
  v_end timestamptz;
  v_today date;
begin
  select * into v_shop from shops where owner_id = auth.uid();
  if not found then
    raise exception 'Set up your shop first.' using errcode = 'P0002';
  end if;
  if v_days is null or v_days < 1 or v_days > 93 then
    raise exception 'Pick a period of up to 93 days.' using errcode = '22023';
  end if;
  v_start := p_from::timestamp at time zone v_shop.time_zone;
  v_end := (p_to + 1)::timestamp at time zone v_shop.time_zone;
  v_today := (now() at time zone v_shop.time_zone)::date;

  return jsonb_build_object(
    -- As shop_summary's totals.
    'takings', (
      select jsonb_build_object(
        'done', count(*) filter (where status = 'completed'),
        'takings', coalesce(sum(price) filter (where status = 'completed'), 0),
        'no_shows', count(*) filter (where status = 'no_show'),
        'no_show_value', coalesce(sum(price) filter (where status = 'no_show'), 0),
        'cancelled', count(*) filter (where status = 'cancelled'),
        'to_come', count(*) filter (where status = 'confirmed' and ends_at > now()),
        'to_come_value', coalesce(sum(price) filter (where status = 'confirmed' and ends_at > now()), 0),
        'unmarked', count(*) filter (where status = 'confirmed' and ends_at <= now()),
        'unmarked_value', coalesce(sum(price) filter (where status = 'confirmed' and ends_at <= now()), 0)
      )
      from bookings bk
      where bk.shop_id = v_shop.id
        and bk.starts_at >= v_start
        and bk.starts_at < v_end
        and not bk.is_block
    ),
    'customers', (
      select jsonb_build_object('total', c.total, 'due', c.due) from public.shop_customer_counts(v_shop.id) c
    ),
    'reviews', jsonb_build_object(
      'count', v_shop.rating_count,
      'sum', v_shop.rating_sum,
      'newest', (
        select jsonb_build_object('rating', r.rating, 'comment', r.comment, 'first_name', r.first_name)
        from reviews r
        where r.shop_id = v_shop.id and r.comment is not null
        order by r.created_at desc
        limit 1
      )
    ),
    'closures', coalesce((
      select jsonb_agg(jsonb_build_object('day', c.day, 'reason', c.reason) order by c.day)
      from shop_closures c
      where c.shop_id = v_shop.id and c.day between v_today and v_today + 60
    ), '[]'::jsonb)
  );
end;
$$;
revoke execute on function public.shop_cards(date, date) from public, anon;
grant execute on function public.shop_cards(date, date) to authenticated;

-- What customers booked, moved or cancelled at the owner's shop since a phone
-- last looked, for the badge on the Bookings tab and the card at its top:
-- how many, the newest change's time (the phone keeps it as when it last
-- looked, so its own clock never matters) and the latest few, newest first.
-- Only bookings that end today or later on the shop's clock; older ones are
-- history. A phone that has never looked (p_since null) gets the last 24
-- hours, and none goes back more than a week. A booking the shop has since
-- cancelled, or taken back after the customer cancelled, is no news to the
-- shop. chair_free says a cancelled time is still to come and nobody has
-- taken it since, so a walk-in can have it, and waiting how many are on the
-- waiting list for its day, who may want it. Every barber's phone asks once
-- a minute, so it is one walk of bookings_shop_changes_idx over the shop's
-- last few days, and a lookup of waitlist_shop_day_idx per cancellation.
-- A generic plan, so a connection plans it once rather than every minute.
create function public.shop_changes(p_since timestamptz default null, p_limit int default 5)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set plan_cache_mode = force_generic_plan
as $$
declare
  v_shop shops;
  v_since timestamptz := greatest(coalesce(p_since, now() - interval '24 hours'), now() - interval '7 days');
  v_today timestamptz;
begin
  select * into v_shop from shops where owner_id = auth.uid();
  if not found then
    return jsonb_build_object('since', v_since, 'count', 0, 'latest', null, 'changes', '[]'::jsonb);
  end if;
  v_today := (now() at time zone v_shop.time_zone)::date::timestamp at time zone v_shop.time_zone;

  return (
    with changed as materialized (
      select b.id, b.barber_id, b.customer_id, b.guest_name, b.service_name, b.starts_at, b.ends_at,
             b.customer_change, b.customer_changed_at
      from bookings b
      where b.shop_id = v_shop.id
        and b.customer_changed_at > v_since
        and b.ends_at > v_today
        and (b.status = 'cancelled') = (b.customer_change = 'cancelled')
    ),
    latest as (
      select * from changed
      order by customer_changed_at desc, id
      limit least(greatest(coalesce(p_limit, 5), 0), 20)
    )
    select jsonb_build_object(
      'since', v_since,
      'count', (select count(*) from changed),
      'latest', (select max(customer_changed_at) from changed),
      'changes', coalesce((
        -- Names one lookup each, however few the planner expects. A deleted
        -- account's name is gone; delete_my_account leaves 'Deleted account'.
        select jsonb_agg(jsonb_build_object(
                 'booking_id', l.id,
                 'barber_id', l.barber_id,
                 'barber_name', (select br.name from barbers br where br.id = l.barber_id),
                 'customer_name', coalesce((select p.full_name from profiles p where p.id = l.customer_id), l.guest_name),
                 'service_name', l.service_name,
                 'starts_at', l.starts_at,
                 'change', l.customer_change,
                 'changed_at', l.customer_changed_at,
                 'chair_free', l.customer_change = 'cancelled' and l.starts_at > now() and not exists (
                   select 1 from bookings x
                   where x.barber_id = l.barber_id
                     and x.status <> 'cancelled'
                     and tstzrange(x.starts_at, x.ends_at) && tstzrange(l.starts_at, l.ends_at)
                 ),
                 'waiting', case when l.customer_change = 'cancelled' and l.starts_at > now() then (
                   select count(*) from waitlist w
                   where w.shop_id = v_shop.id and w.day = (l.starts_at at time zone v_shop.time_zone)::date
                 ) else 0 end
               ) order by l.customer_changed_at desc, l.id)
        from latest l
      ), '[]'::jsonb)
    )
  );
end;
$$;

-- What My shop's "Get your shop ready" card and its Go live button need:
-- how many services customers can book, and the active barbers in the
-- team's order with whether each works at least one day a week (so the card
-- can open the hours of one who doesn't). Only the caller's own shop; null
-- without one. The app asks only while the shop isn't live or the card can
-- still show, and it is a lookup of one shop's few barbers and services.
create function public.shop_setup()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'services', (select count(*)::int from services v where v.shop_id = s.id and v.is_active),
    'barbers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id,
               'name', b.name,
               'has_hours', exists (select 1 from working_hours wh where wh.barber_id = b.id)
             ) order by b.sort_order, b.created_at, b.id)
      from barbers b
      where b.shop_id = s.id and b.is_active
    ), '[]'::jsonb)
  )
  from shops s
  where s.owner_id = auth.uid();
$$;

-- A customer's own bookings, newest first, each with its shop and barber.
-- Customers can only read live shops (and their barbers), so a plain select
-- of bookings with shops(...) lost the shop's name, address and phone the
-- moment it paused: the booking still stood, but the customer no longer knew
-- where to go or how to reach the shop. is_live says whether it still takes
-- online bookings, so the app can hide Change time and say why. review is
-- the customer's rating of that cut, the name it shows and the shop's reply,
-- or null. Sent as {bookings, waitlist, queue}: the days they are waiting
-- on (my_waitlist) and their place in a walk-in queue today (my_queue) come
-- in the same answer, so My bookings is one request rather than three. plpgsql with a generic plan, so a connection plans it
-- once rather than on every visit.
create function public.my_bookings(p_limit int default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set plan_cache_mode = force_generic_plan
as $$
begin
  return jsonb_build_object(
    'bookings', (
      select coalesce(jsonb_agg(x.item order by x.starts_at desc, x.id), '[]'::jsonb)
      from (
        select b.id, b.starts_at,
               to_jsonb(b) || jsonb_build_object(
                 'shops', jsonb_build_object(
                   'name', s.name, 'slug', s.slug, 'address', s.address, 'area', s.area,
                   'latitude', s.latitude, 'longitude', s.longitude,
                   'phone', s.phone, 'time_zone', s.time_zone, 'is_live', public.shop_is_live(s)),
                 'barbers', jsonb_build_object('name', br.name),
                 'review', case when r.booking_id is not null then jsonb_build_object(
                   'rating', r.rating, 'comment', r.comment, 'first_name', r.first_name, 'reply', r.reply,
                   'replied_at', r.replied_at, 'created_at', r.created_at, 'updated_at', r.updated_at) end) as item
        from bookings b
        join shops s on s.id = b.shop_id
        join barbers br on br.id = b.barber_id
        left join reviews r on r.booking_id = b.id
        where b.customer_id = auth.uid()
        order by b.starts_at desc, b.id
        limit least(greatest(coalesce(p_limit, 100), 1), 200)
      ) x
    ),
    'waitlist', public.my_waitlist(),
    'queue', public.my_queue());
end;
$$;

-- Waiting list -----------------------------------------------------------------

-- How many days one customer can wait on at a time, across every shop, so
-- one account can't queue for every shop's busy Saturday.
create function public.max_waiting_per_customer() returns int language sql immutable as $$ select 3 $$;

-- A signed-in customer asks to hear if a time frees up on a day, for a
-- service with a barber (null: any). The day must be one they could book:
-- the shop live, the service and barber still offered, today up to the
-- booking horizon by the shop's clock, the shop not closed, and someone
-- in that day (the barber asked for, if any). Whether the day is full is
-- the app's to judge: a time may have freed up by now, and waiting then
-- does no harm.
create function public.join_waitlist(p_service_id uuid, p_day date, p_barber_id uuid default null)
returns public.waitlist
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_service services;
  v_shop shops;
  v_today date;
  v_open boolean;
  v_barber_in boolean;
  v_row waitlist;
begin
  if v_uid is null then
    raise exception 'Please sign in to join the waiting list.' using errcode = '28000';
  end if;

  select * into v_service from services where id = p_service_id and is_active;
  select * into v_shop from shops where id = v_service.shop_id;
  if v_shop.id is null or not public.shop_is_live(v_shop) then
    raise exception 'This service is no longer available.' using errcode = 'P0002';
  end if;

  if p_barber_id is not null and not exists (
    select 1 from barbers where id = p_barber_id and shop_id = v_shop.id and is_active
  ) then
    raise exception 'Barber not found.' using errcode = 'P0002';
  end if;

  v_today := (now() at time zone v_shop.time_zone)::date;
  if p_day is null or p_day < v_today or p_day > v_today + public.booking_horizon_days() then
    raise exception 'Pick a day from today up to 60 days ahead.' using errcode = '22023';
  end if;

  -- Who is in that day: working it and without the whole day blocked off.
  -- The booking page shows such days as closed, or off for that barber, so
  -- these only catch a day that changed while it was open. Like the day
  -- range, 22023: the day itself can't be waited on.
  select bool_or(true), bool_or(b.id = p_barber_id) into v_open, v_barber_in
  from barbers b
  where b.shop_id = v_shop.id and b.is_active
    and exists (select 1 from working_hours wh where wh.barber_id = b.id and wh.weekday = extract(dow from p_day)::int)
    and not exists (
      select 1 from bookings bk
      where bk.barber_id = b.id and bk.status = 'confirmed'
        and tstzrange(bk.starts_at, bk.ends_at) @> tstzrange(
              p_day::timestamp at time zone v_shop.time_zone,
              (p_day + 1)::timestamp at time zone v_shop.time_zone)
    );
  if exists (select 1 from shop_closures c where c.shop_id = v_shop.id and c.day = p_day) or v_open is null then
    raise exception 'The shop isn''t taking bookings that day.' using errcode = '22023';
  end if;
  if p_barber_id is not null and not v_barber_in then
    raise exception 'That barber is off that day. Try any barber.' using errcode = '22023';
  end if;

  -- One at a time per customer, so two at once can't both get under the
  -- limit. Then the shop's diary, so a booking of theirs being saved for
  -- that day is seen below rather than leaving them waiting after it.
  perform pg_advisory_xact_lock(hashtextextended('waitlist:' || v_uid, 0));
  perform public.lock_shop_diary(v_shop.id);

  if exists (
    select 1 from bookings
    where customer_id = v_uid and shop_id = v_shop.id and status = 'confirmed'
      and starts_at >= p_day::timestamp at time zone v_shop.time_zone
      and starts_at < (p_day + 1)::timestamp at time zone v_shop.time_zone
  ) then
    raise exception 'You already have a booking here that day.' using errcode = 'P0001';
  end if;

  if exists (select 1 from waitlist where customer_id = v_uid and day = p_day and shop_id = v_shop.id) then
    raise exception 'You''re already on the waiting list for that day.' using errcode = 'P0001';
  end if;

  -- Days gone by don't count, and nothing clears them on a timer.
  delete from waitlist w using shops s
  where w.customer_id = v_uid and s.id = w.shop_id and w.day < (now() at time zone s.time_zone)::date;

  if (select count(*) from waitlist where customer_id = v_uid) >= public.max_waiting_per_customer() then
    raise exception 'You can be on % waiting lists at a time. Leave one to join another.',
      public.max_waiting_per_customer() using errcode = 'P0001';
  end if;

  insert into waitlist (shop_id, customer_id, day, service_id, barber_id)
  values (v_shop.id, v_uid, p_day, v_service.id, p_barber_id)
  returning * into v_row;
  return v_row;
end;
$$;

-- The customer leaves a waiting list, or the shop takes them off its own.
-- Already gone is fine: the other side may have just done it, or they
-- booked.
create function public.leave_waitlist(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from waitlist
  where id = p_id
    and (customer_id = (select auth.uid()) or shop_id = (select public.my_shop_id()));
$$;

-- The shop WhatsApped someone on its waiting list, so every phone in the
-- shop sees it was done and when.
create function public.mark_waitlist_offered(p_id uuid)
returns public.waitlist
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row waitlist;
begin
  update waitlist set offered_at = now()
  where id = p_id and shop_id = public.my_shop_id()
  returning * into v_row;
  if not found then
    raise exception 'They''re no longer on the waiting list.' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

-- The owner's waiting list for one day, oldest request first, with each
-- customer's name and number as the shop's customer list shows them, and
-- what they asked for. Empty for a day gone by. The barber's day asks for
-- it alongside its bookings, so it is one lookup of waitlist_shop_day_idx.
-- plpgsql with a generic plan, so a connection plans it once: as plain SQL
-- planning it took over ten times as long as running it.
create function public.shop_waitlist(p_day date)
returns table (
  id uuid, name text, phone text, service_id uuid, service_name text, duration_min int,
  barber_id uuid, barber_name text, created_at timestamptz, offered_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
set plan_cache_mode = force_generic_plan
as $$
#variable_conflict use_column
begin
  return query
  select w.id, nullif(trim(p.full_name), ''), p.phone, w.service_id, v.name, v.duration_min,
         w.barber_id, b.name, w.created_at, w.offered_at
  from shops sh
  join waitlist w on w.shop_id = sh.id and w.day = p_day
  join profiles p on p.id = w.customer_id
  join services v on v.id = w.service_id
  left join barbers b on b.id = w.barber_id
  where sh.owner_id = (select auth.uid())
    and p_day >= (now() at time zone sh.time_zone)::date
  order by w.created_at, w.id;
end;
$$;

-- A customer's own requests still to come, soonest day first, each with
-- its shop (by id too, so the shop's page can tell without asking again),
-- service and barber. Read through the customer's end of waitlist_one_a_day.
-- plpgsql, so a connection plans it once.
create function public.my_waitlist()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return (select coalesce(jsonb_agg(jsonb_build_object(
           'id', w.id, 'shop_id', w.shop_id, 'day', w.day,
           'service_id', w.service_id, 'service_name', v.name,
           'barber_id', w.barber_id, 'barber_name', b.name, 'created_at', w.created_at,
           'shop', jsonb_build_object('name', s.name, 'slug', s.slug, 'time_zone', s.time_zone)
         ) order by w.day, w.created_at, w.id), '[]'::jsonb)
  from waitlist w
  join shops s on s.id = w.shop_id
  join services v on v.id = w.service_id
  left join barbers b on b.id = w.barber_id
  where w.customer_id = (select auth.uid())
    and w.day >= (now() at time zone s.time_zone)::date);
end;
$$;

-- Walk-in queue ---------------------------------------------------------------

-- How many can wait in one shop's queue at once, so its page can't be
-- flooded with sign-ups.
create function public.max_queue_waiting() returns int language sql immutable as $$ select 30 $$;
-- How many times one customer can join one shop's queue in a day, so
-- joining and leaving over and over can't pile up entries.
create function public.max_queue_joins_a_day() returns int language sql immutable as $$ select 5 $$;
-- How long a customer the shop took off is told so.
create function public.queue_taken_off_shown() returns interval language sql immutable as $$ select interval '1 hour' $$;

-- The shop's barbers in right now by its own clock: active, inside one of
-- today's working ranges, and without the whole day off, while the shop
-- isn't closed today. The queue is open while anyone is. A break between
-- ranges counts as out; blocked time inside a range doesn't, as the barber
-- is coming back. With p_whole_day, everyone working today, in now or not:
-- the shop can still start a cut for someone who waited past closing time,
-- or with a barber back from a break a minute early. plpgsql for the same
-- reason as shop_hours_today.
create function public.barbers_in_now(p_shop_id uuid, p_tz text, p_whole_day boolean default false)
returns setof public.barbers
language plpgsql
stable
set search_path = public
as $$
declare
  v_local timestamp := now() at time zone p_tz;
  v_day date := (now() at time zone p_tz)::date;
begin
  if exists (select 1 from shop_closures c where c.shop_id = p_shop_id and c.day = v_day) then
    return;
  end if;
  return query
  select b.* from barbers b
  where b.shop_id = p_shop_id and b.is_active
    and exists (
      select 1 from working_hours wh
      where wh.barber_id = b.id and wh.weekday = extract(dow from v_day)::int
        and (p_whole_day or (wh.opens_at <= v_local::time and v_local::time < wh.closes_at))
    )
    and b.id not in (
      select bk.barber_id from bookings bk
      where bk.shop_id = p_shop_id
        and bk.starts_at >= v_day::timestamp at time zone p_tz
        and bk.starts_at < (v_day + 1)::timestamp at time zone p_tz
        and bk.is_block
        and bk.status = 'confirmed'
        and bk.ends_at - bk.starts_at >= interval '24 hours'
    )
  order by b.sort_order, b.created_at, b.id;
end;
$$;

-- About how long until someone joining now gets a chair: the cuts waiting
-- ahead added up and shared among the barbers in, rounded up to 5 minutes.
-- src/lib/queue.ts (queueEstimate) works it out the same way.
create function public.queue_estimate(p_minutes bigint, p_barbers int)
returns int
language sql
immutable
as $$
  select case when coalesce(p_minutes, 0) <= 0 then 0
              else (ceil(p_minutes::numeric / greatest(coalesce(p_barbers, 0), 1) / 5) * 5)::int end;
$$;

-- What a shop's page needs about its queue, in one call: whether it is open
-- now (the shop live, its queue on and someone in), how many are waiting,
-- about how long someone joining now would wait, and the caller's own
-- place in it today, if any, with the wait ahead of them. Customers see
-- counts, never who. A waiting entry with no service counts as the shop's
-- shortest one. The page asks every 30 seconds while its customer waits:
-- one lookup of queue_entries_shop_day_idx for today, and one of theirs.
-- Their place is their latest entry here today, so one the shop took off
-- in the last hour (taken off while waiting, or not here when called) is
-- still given, gone, so the page can say what happened rather than just
-- offer the queue again; a newer one takes its place.
create function public.queue_status(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_shop shops;
  v_day date;
  v_in int;
  v_default int;
  v_mine queue_entries;
  v_waiting int;
  v_minutes bigint;
  v_ahead int;
  v_ahead_minutes bigint;
begin
  select * into v_shop from shops where id = p_shop_id;
  if not found then
    return jsonb_build_object('open', false, 'waiting', 0, 'estimate_min', 0, 'barbers_in', 0, 'mine', null);
  end if;
  v_day := (now() at time zone v_shop.time_zone)::date;
  select count(*) into v_in from public.barbers_in_now(v_shop.id, v_shop.time_zone);
  select min(duration_min) into v_default from services where shop_id = v_shop.id and is_active;

  if v_uid is not null then
    select * into v_mine from queue_entries e
    where e.customer_id = v_uid and e.day = v_day and e.shop_id = v_shop.id
    order by e.created_at desc, e.id desc
    limit 1;
    if v_mine.state = 'gone' and not (
      v_mine.gone_reason in ('removed', 'not_here') and v_mine.gone_at > now() - public.queue_taken_off_shown()
    ) then
      v_mine := null;
    end if;
  end if;

  select count(*), sum(coalesce(v.duration_min, v_default, 30)),
         count(*) filter (where (e.created_at, e.id) < (v_mine.created_at, v_mine.id)),
         sum(coalesce(v.duration_min, v_default, 30)) filter (where (e.created_at, e.id) < (v_mine.created_at, v_mine.id))
    into v_waiting, v_minutes, v_ahead, v_ahead_minutes
  from queue_entries e
  left join services v on v.id = e.service_id
  where e.shop_id = v_shop.id and e.day = v_day and e.state = 'waiting';

  return jsonb_build_object(
    'open', public.shop_is_live(v_shop) and v_shop.queue_enabled and v_in > 0,
    'waiting', v_waiting,
    'estimate_min', public.queue_estimate(v_minutes, v_in),
    'barbers_in', v_in,
    'mine', case when v_mine.id is not null then jsonb_build_object(
      'id', v_mine.id, 'state', v_mine.state, 'gone_reason', v_mine.gone_reason, 'called_at', v_mine.called_at,
      'service_id', v_mine.service_id, 'barber_id', v_mine.barber_id, 'created_at', v_mine.created_at,
      'place', case when v_mine.state = 'waiting' then v_ahead + 1 end,
      'estimate_min', case when v_mine.state = 'waiting' then public.queue_estimate(v_ahead_minutes, v_in) end
    ) end
  );
end;
$$;

-- A signed-in customer joins a shop's queue for today, for a service with a
-- barber (null: any), while the queue is open (see queue_status) and the
-- barber asked for is in. One place at a time across every shop, as
-- someone can only sit in one chair; none at a shop where they have a
-- booking still to come today, as they have a time; no more than
-- max_queue_waiting waiting; and a few times a day at one shop.
create function public.join_queue(p_service_id uuid, p_barber_id uuid default null)
returns public.queue_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_service services;
  v_shop shops;
  v_day date;
  v_in int;
  v_barber_in boolean;
  v_other uuid;
  v_row queue_entries;
begin
  if v_uid is null then
    raise exception 'Please sign in to join the queue.' using errcode = '28000';
  end if;

  select * into v_service from services where id = p_service_id and is_active;
  select * into v_shop from shops where id = v_service.shop_id;
  if v_shop.id is null or not public.shop_is_live(v_shop) then
    raise exception 'This service is no longer available.' using errcode = 'P0002';
  end if;
  if p_barber_id is not null and not exists (
    select 1 from barbers where id = p_barber_id and shop_id = v_shop.id and is_active
  ) then
    raise exception 'Barber not found.' using errcode = 'P0002';
  end if;

  select count(*), coalesce(bool_or(b.id = p_barber_id), false) into v_in, v_barber_in
  from public.barbers_in_now(v_shop.id, v_shop.time_zone) b;
  if not v_shop.queue_enabled or v_in = 0 then
    raise exception 'The queue isn''t open right now.' using errcode = 'P0001';
  end if;
  if p_barber_id is not null and not v_barber_in then
    raise exception 'That barber isn''t in right now. Try any barber.' using errcode = 'P0001';
  end if;

  v_day := (now() at time zone v_shop.time_zone)::date;

  -- One at a time per customer, so two at once can't both get in. Then the
  -- shop's diary, so a booking of theirs being saved now is seen below, and
  -- the queue's order and count are those of the moment each one is saved.
  perform pg_advisory_xact_lock(hashtextextended('queue:' || v_uid, 0));
  perform public.lock_shop_diary(v_shop.id);

  if exists (
    select 1 from bookings
    where customer_id = v_uid and shop_id = v_shop.id and status = 'confirmed'
      and starts_at >= v_day::timestamp at time zone v_shop.time_zone
      and starts_at < (v_day + 1)::timestamp at time zone v_shop.time_zone
      and ends_at > now()
  ) then
    raise exception 'You already have a booking here today.' using errcode = 'P0001';
  end if;

  -- Their place in any shop's queue today by that shop's clock, which is
  -- never more than a day from this one's.
  select e.shop_id into v_other
  from queue_entries e
  join shops s on s.id = e.shop_id
  where e.customer_id = v_uid and e.day between v_day - 1 and v_day + 1
    and e.state <> 'gone' and e.day = (now() at time zone s.time_zone)::date
  limit 1;
  if v_other = v_shop.id then
    raise exception 'You''re already in this queue.' using errcode = 'P0001';
  elsif v_other is not null then
    raise exception 'You''re already in another shop''s queue. Leave it to join this one.' using errcode = 'P0001';
  end if;
  if (select count(*) from queue_entries where customer_id = v_uid and day = v_day and shop_id = v_shop.id)
     >= public.max_queue_joins_a_day() then
    raise exception 'You can join this queue % times a day. Book a time instead.', public.max_queue_joins_a_day()
      using errcode = 'P0001';
  end if;

  if (select count(*) from queue_entries where shop_id = v_shop.id and day = v_day and state = 'waiting')
     >= public.max_queue_waiting() then
    raise exception 'The queue is full for now. Try booking a time instead.' using errcode = 'P0001';
  end if;

  insert into queue_entries (shop_id, day, customer_id, service_id, barber_id, created_at)
  values (v_shop.id, v_day, v_uid, v_service.id, p_barber_id, clock_timestamp())
  returning * into v_row;
  return v_row;
end;
$$;

-- The customer leaves the queue, or says they no longer need their turn.
-- Already gone is fine: the shop may have just taken them off.
create function public.leave_queue(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update queue_entries set state = 'gone', gone_reason = 'left', gone_at = now()
  where id = p_id and customer_id = (select auth.uid()) and state <> 'gone';
$$;

-- The shop adds someone who walked in: a name, their number if they give
-- one, and the service and barber if they said. Barbers use the owner's
-- account, so it is the owner's shop. Whenever its queue is on, as a shop
-- may take names before it opens; the same limit as online.
create function public.add_to_queue(
  p_name text,
  p_phone text default null,
  p_service_id uuid default null,
  p_barber_id uuid default null
)
returns public.queue_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop shops;
  v_day date;
  v_row queue_entries;
begin
  select * into v_shop from shops where owner_id = auth.uid();
  if not found then
    raise exception 'Set up your shop first.' using errcode = 'P0002';
  end if;
  if not v_shop.queue_enabled then
    raise exception 'Turn on the walk-in queue in My shop first.' using errcode = 'P0001';
  end if;
  if nullif(trim(p_name), '') is null then
    raise exception 'Add the customer''s name.' using errcode = '22023';
  end if;
  if p_service_id is not null and not exists (select 1 from services where id = p_service_id and shop_id = v_shop.id) then
    raise exception 'Service not found.' using errcode = 'P0002';
  end if;
  if p_barber_id is not null and not exists (select 1 from barbers where id = p_barber_id and shop_id = v_shop.id) then
    raise exception 'Barber not found.' using errcode = 'P0002';
  end if;

  v_day := (now() at time zone v_shop.time_zone)::date;
  perform public.lock_shop_diary(v_shop.id);
  if (select count(*) from queue_entries where shop_id = v_shop.id and day = v_day and state = 'waiting')
     >= public.max_queue_waiting() then
    raise exception 'The queue is full for now. Try booking a time instead.' using errcode = 'P0001';
  end if;

  insert into queue_entries (shop_id, day, guest_name, guest_phone, service_id, barber_id, created_at)
  values (v_shop.id, v_day, trim(p_name), nullif(trim(p_phone), ''), p_service_id, p_barber_id, clock_timestamp())
  returning * into v_row;
  return v_row;
end;
$$;

-- The shop calls someone: their page and My bookings say it is their turn.
-- Calling again (they didn't hear) notes the new time.
create function public.call_from_queue(p_id uuid)
returns public.queue_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row queue_entries;
begin
  update queue_entries e set state = 'called', called_at = now()
  from shops s
  where e.id = p_id and s.id = e.shop_id and s.owner_id = auth.uid()
    and e.day = (now() at time zone s.time_zone)::date and e.state <> 'gone'
  returning e.* into v_row;
  if not found then
    raise exception 'They''re no longer in the queue.' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

-- The shop takes someone off: not here when called, or taken off while
-- waiting. Already gone is fine.
create function public.remove_from_queue(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update queue_entries e
  set state = 'gone', gone_reason = case when e.state = 'called' then 'not_here' else 'removed' end, gone_at = now()
  from shops s
  where e.id = p_id and s.id = e.shop_id and s.owner_id = (select auth.uid()) and e.state <> 'gone';
$$;

-- Starting someone's cut makes it an ordinary booking with the barber who
-- takes them, from now (to the minute) for the service's length, so it
-- counts in takings, the customer list, reviews and the chairs like any
-- other. The service is theirs unless the shop picks another, and the
-- barber must be working today (in now, or not: past closing time the shop
-- still serves who is left) and free until the cut would end: a booking in
-- the way is named, so the shop can pick someone else. Its start time is
-- the error's detail, for the app to say in the customer's own clock.
create function public.start_from_queue(p_id uuid, p_barber_id uuid, p_service_id uuid default null)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop shops;
  v_entry queue_entries;
  v_service services;
  v_barber barbers;
  v_starts timestamptz := date_trunc('minute', now());
  v_ends timestamptz;
  v_clash bookings;
  v_clock text;
  v_booking bookings;
begin
  select * into v_shop from shops where owner_id = auth.uid();
  if not found then
    raise exception 'Set up your shop first.' using errcode = 'P0002';
  end if;

  perform public.lock_shop_diary(v_shop.id);
  select * into v_entry from queue_entries
  where id = p_id and shop_id = v_shop.id and state <> 'gone'
    and day = (now() at time zone v_shop.time_zone)::date;
  if not found then
    raise exception 'They''re no longer in the queue.' using errcode = 'P0002';
  end if;

  select * into v_service from services
  where id = coalesce(p_service_id, v_entry.service_id) and shop_id = v_shop.id;
  if not found then
    raise exception 'Pick a service for their cut.' using errcode = '22023';
  end if;

  if not exists (select 1 from barbers where id = p_barber_id and shop_id = v_shop.id) then
    raise exception 'Barber not found.' using errcode = 'P0002';
  end if;
  select * into v_barber from public.barbers_in_now(v_shop.id, v_shop.time_zone, true) b where b.id = p_barber_id;
  if not found then
    raise exception 'That barber isn''t working today. Pick another barber.' using errcode = 'P0001';
  end if;

  v_ends := v_starts + make_interval(mins => v_service.duration_min);
  select * into v_clash from bookings
  where barber_id = v_barber.id and status <> 'cancelled'
    and tstzrange(starts_at, ends_at) && tstzrange(v_starts, v_ends)
  order by starts_at
  limit 1;
  if found and v_clash.starts_at <= v_starts then
    raise exception '% is busy until %. Pick another barber.', v_barber.name,
      lower(to_char(v_clash.ends_at at time zone v_shop.time_zone, 'FMHH12:MI AM'))
      using errcode = 'P0001', detail = to_jsonb(v_clash.ends_at) #>> '{}';
  elsif found then
    v_clock := lower(to_char(v_clash.starts_at at time zone v_shop.time_zone, 'FMHH12:MI AM'));
    -- "an 8:00 am", "an 11:30 am": said with a vowel.
    raise exception '% has % % booking before this cut would finish. Pick another barber.', v_barber.name,
      case when v_clock ~ '^(8|11):' then 'an' else 'a' end, v_clock
      using errcode = 'P0001', detail = to_jsonb(v_clash.starts_at) #>> '{}';
  end if;

  insert into bookings (
    shop_id, barber_id, service_id, customer_id, guest_name, guest_phone,
    service_name, price, starts_at, ends_at
  ) values (
    v_shop.id, v_barber.id, v_service.id, v_entry.customer_id,
    case when v_entry.customer_id is null then v_entry.guest_name end,
    case when v_entry.customer_id is null then v_entry.guest_phone end,
    v_service.name, v_service.price, v_starts, v_ends
  )
  returning * into v_booking;

  update queue_entries set state = 'gone', gone_reason = 'served', gone_at = now(), booking_id = v_booking.id
  where id = v_entry.id;
  return v_booking;
end;
$$;

-- The shop's queue today, in order: who is waiting or has been called, with
-- each one's name and number as the customer list shows them (an online
-- customer's account, or what the shop wrote down), and what they asked
-- for. The barber's day asks for it with its bookings every minute while
-- the queue is on: one lookup of queue_entries_shop_day_idx. plpgsql, so
-- each connection plans it once: as plain SQL, planning it on every call
-- took ten times as long as running it.
create function public.shop_queue()
returns table (
  id uuid, name text, phone text, online boolean, service_id uuid, service_name text, duration_min int,
  barber_id uuid, barber_name text, state text, called_at timestamptz, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return query
  select e.id, coalesce(nullif(trim(p.full_name), ''), e.guest_name),
         case when e.customer_id is null then e.guest_phone else p.phone end,
         e.customer_id is not null, e.service_id, v.name, v.duration_min,
         e.barber_id, b.name, e.state, e.called_at, e.created_at
  from shops sh
  join queue_entries e
    on e.shop_id = sh.id and e.day = (now() at time zone sh.time_zone)::date and e.state <> 'gone'
  left join profiles p on p.id = e.customer_id
  left join services v on v.id = e.service_id
  left join barbers b on b.id = e.barber_id
  where sh.owner_id = (select auth.uid())
  order by e.created_at, e.id;
end;
$$;

-- The customer's place in a queue today, if they are in one (at most one,
-- see join_queue), with its shop, what they asked for, and their place and
-- wait as queue_status works them out; also a place the shop took off in
-- the last hour, gone, as queue_status gives it. My bookings asks every 30
-- seconds while they wait: one lookup of their own entries for today, then
-- queue_status for that shop. plpgsql, as shop_queue is.
create function public.my_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return (
  select coalesce(jsonb_agg(
           q.mine || jsonb_build_object(
             'shop_id', s.id, 'service_name', v.name, 'barber_name', b.name,
             'shop', jsonb_build_object('name', s.name, 'slug', s.slug, 'time_zone', s.time_zone,
                                        'phone', s.phone, 'address', s.address, 'area', s.area,
                                        'latitude', s.latitude, 'longitude', s.longitude))
           order by (q.mine ->> 'created_at')::timestamptz, q.mine ->> 'id'), '[]'::jsonb)
  from (
    select distinct e.shop_id
    from queue_entries e
    join shops s on s.id = e.shop_id
    where e.customer_id = (select auth.uid())
      and e.day between current_date - 1 and current_date + 1
      and e.day = (now() at time zone s.time_zone)::date
      and (e.state <> 'gone'
           or (e.gone_reason in ('removed', 'not_here') and e.gone_at > now() - public.queue_taken_off_shown()))
  ) mine
  join shops s on s.id = mine.shop_id
  -- offset 0 keeps it one call: otherwise each use of q.mine below calls it again.
  cross join lateral (select public.queue_status(s.id) -> 'mine' as mine offset 0) q
  left join services v on v.id = (q.mine ->> 'service_id')::uuid
  left join barbers b on b.id = (q.mine ->> 'barber_id')::uuid
  where jsonb_typeof(q.mine) = 'object');
end;
$$;

-- Reviews ----------------------------------------------------------------------

-- The name a review shows unless the customer picks another: the name they
-- go by, never a surname or their father's name. "Mohd Hakim bin Ali" is
-- Hakim, "Muhammad bin Abdullah" is Muhammad, "Wan Abdul Rahman" is Abdul
-- Rahman and "Tan Wei Jie" is Wei Jie. src/lib/reviews.ts (firstName) does
-- the same for the app's form and the demo, with the same word lists.
create function public.review_first_name(p_full_name text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_words text[] := regexp_split_to_array(btrim(coalesce(p_full_name, ''), E' \t\r\n'), '\s+');
  v_name text;
begin
  -- What follows bin, binti or a/l is the father's name.
  for i in 2 .. array_length(v_words, 1) loop
    if rtrim(lower(v_words[i]), '.''’') in ('bin', 'binti', 'binte', 'bte', 'bt', 'b', 'a/l', 'a/p', 's/o', 'd/o') then
      v_words := v_words[1:i - 1];
      exit;
    end if;
  end loop;
  -- Muhammad and Mohd, titles, and hereditary names like Wan or Syed, while another word follows.
  while array_length(v_words, 1) > 1 and rtrim(lower(v_words[1]), '.''’') in (
    'muhammad', 'muhamad', 'mohammad', 'mohamad', 'mohammed', 'mohamed', 'mohd', 'muhd', 'mhd', 'md',
    'wan', 'nik', 'syed', 'sayed', 'sharifah', 'syarifah', 'tengku', 'tunku', 'raja', 'megat', 'che',
    'dr', 'haji', 'hj', 'hajah', 'hjh', 'encik', 'en', 'tuan', 'puan', 'cik', 'dato', 'datuk', 'datin') loop
    v_words := v_words[2:];
  end loop;
  -- Three words after a common Chinese surname are surname first; Abdul goes with the next word.
  if array_length(v_words, 1) = 3 and rtrim(lower(v_words[1]), '.''’') in (
    'tan', 'lim', 'lee', 'ng', 'wong', 'chan', 'ong', 'teh', 'goh', 'leong', 'lau', 'yap', 'low', 'cheah', 'khoo',
    'koh', 'chua', 'foo', 'loh', 'liew', 'yeoh', 'ooi', 'tay', 'chew', 'ang', 'soh', 'teo', 'toh', 'phang', 'choong',
    'lam', 'chai', 'chia', 'gan', 'mah', 'mak', 'quek', 'seow', 'woo', 'yeo', 'yip', 'choy', 'hii', 'ho') then
    v_name := v_words[2] || ' ' || v_words[3];
  elsif array_length(v_words, 1) > 1 and rtrim(lower(v_words[1]), '.''’') in ('abdul', 'abd') then
    v_name := v_words[1] || ' ' || v_words[2];
  else
    v_name := v_words[1];
  end if;
  return coalesce(nullif(rtrim(left(v_name, 40), ' '), ''), 'Customer');
end;
$$;

-- The booking's own customer rates their cut, 1 to 5 stars with an optional
-- comment, once the shop has marked it done and for 14 days after it started
-- (src/lib/reviews.ts shows the same window). Rating again in that time
-- changes the same review. Owners can't rate their own shop. p_name is the
-- name the review shows, as the customer saw or changed it on the form;
-- without it a new review takes review_first_name and a changed one keeps
-- its name.
create function public.rate_booking(p_booking_id uuid, p_rating int, p_comment text default null,
                                    p_name text default null)
returns public.reviews
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking bookings;
  v_comment text := nullif(btrim(p_comment, E' \t\r\n'), '');
  v_name text := nullif(rtrim(left(btrim(regexp_replace(p_name, '\s+', ' ', 'g'), ' '), 40), ' '), '');
  v_review reviews;
begin
  select * into v_booking from bookings where id = p_booking_id;
  if not found or v_booking.customer_id is distinct from auth.uid() then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;
  if public.owns_shop(v_booking.shop_id) then
    raise exception 'You can''t rate your own shop.' using errcode = '42501';
  end if;
  if v_booking.status <> 'completed' or now() >= v_booking.starts_at + interval '14 days' then
    raise exception 'You can rate a cut once the shop marks it done, until 14 days after it.' using errcode = '42501';
  end if;
  if p_rating is null or p_rating not between 1 and 5 then
    raise exception 'Pick from 1 to 5 stars.' using errcode = '22023';
  end if;
  if length(v_comment) > 280 then
    raise exception 'Please keep your comment under 280 characters.' using errcode = '22001';
  end if;

  insert into reviews (booking_id, shop_id, barber_id, customer_id, rating, comment, first_name)
  values (v_booking.id, v_booking.shop_id, v_booking.barber_id, v_booking.customer_id, p_rating, v_comment,
          coalesce(v_name, (select public.review_first_name(full_name) from profiles where id = auth.uid()), 'Customer'))
  on conflict (booking_id) do update set
    rating = excluded.rating,
    comment = excluded.comment,
    first_name = coalesce(v_name, reviews.first_name),
    updated_at = now()
  returning * into v_review;
  return v_review;
end;
$$;

-- The shop's owner replies under a review, or changes their reply. An empty
-- reply takes it away.
create function public.reply_to_review(p_booking_id uuid, p_reply text)
returns public.reviews
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reply text := nullif(btrim(p_reply, E' \t\r\n'), '');
  v_review reviews;
begin
  select * into v_review from reviews where booking_id = p_booking_id;
  if not found or not public.owns_shop(v_review.shop_id) then
    raise exception 'Review not found.' using errcode = 'P0002';
  end if;
  if length(v_reply) > 280 then
    raise exception 'Please keep your reply under 280 characters.' using errcode = '22001';
  end if;
  update reviews set reply = v_reply, replied_at = case when v_reply is not null then now() end
  where booking_id = p_booking_id
  returning * into v_review;
  return v_review;
end;
$$;

-- What Find a barber shows a returning customer above the list, in one call:
-- their soonest upcoming booking and how many they have ("Your next cut"),
-- and up to three shops where they had cuts in the last two years, most
-- recent first ("Your barbers"). Each shop comes with its last cut there, so
-- Book again can pick the same service and barber; their visits and usual
-- gap there, worked out as shop_customers does; whether it still takes
-- online bookings; and today's hours and next free time as the shop list
-- has them. The app decides from these whether they are due for a cut
-- (lib/my-shops.ts). Only the caller's own online bookings, read through
-- bookings_customer_idx: walk-ins the shop added under their number are the
-- shop's to see. Their shops and barbers are then looked up by id (offset
-- 0 stops the planner reading every shop and barber on the platform
-- instead), and only the three shops get their hours and next free time,
-- in one call each. plpgsql, so a connection plans it once: as plain SQL
-- planning it took a quarter of its time.
create function public.my_shops()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return (
  with mine as materialized (
    select b.id, b.shop_id, b.barber_id, b.service_id, b.service_name, b.starts_at, b.status
    from bookings b
    where b.customer_id = (select auth.uid())
      and b.starts_at >= now() - interval '2 years'
      and b.status in ('confirmed', 'completed')
  ),
  visits as (
    -- A cut marked done, or still confirmed once it started, since not
    -- every barber marks each cut done.
    select m.* from mine m where m.status = 'completed' or m.starts_at <= now()
  ),
  recent as materialized (
    -- The last cut at each shop, the three latest of those.
    select l.*, s.name, s.slug, s.time_zone, s.is_live, br.name as barber_name
    from (
      select * from (
        select distinct on (v.shop_id) v.* from visits v order by v.shop_id, v.starts_at desc, v.id
      ) c
      order by c.starts_at desc, c.shop_id
      limit 3
    ) l
    cross join lateral (
      select x.name, x.slug, x.time_zone, public.shop_is_live(x) as is_live from shops x where x.id = l.shop_id offset 0
    ) s
    cross join lateral (select x.name from barbers x where x.id = l.barber_id offset 0) br
  ),
  page as (
    select array_agg(r.shop_id) as ids from recent r
  ),
  habits as (
    -- Two cuts on one day (the shop's) are one visit. Exact halves round
    -- up, as in shop_customers.
    select g.shop_id, count(*)::int as visits,
           round((percentile_cont(0.5) within group (order by g.gap))::numeric)::int as median_gap
    from (
      select d.shop_id, d.day - lag(d.day) over (partition by d.shop_id order by d.day) as gap
      from (
        select distinct v.shop_id, (v.starts_at at time zone r.time_zone)::date as day
        from visits v
        join recent r on r.shop_id = v.shop_id
      ) d
    ) g
    group by g.shop_id
  ),
  upcoming as (
    select m.* from mine m where m.status = 'confirmed' and m.starts_at > now()
  )
  select jsonb_build_object(
    'next', (
      select jsonb_build_object('id', u.id, 'starts_at', u.starts_at, 'service_name', u.service_name,
                                'barber_name', br.name, 'shop_name', s.name, 'time_zone', s.time_zone)
      from (select * from upcoming order by starts_at, id limit 1) u
      cross join lateral (select x.name, x.time_zone from shops x where x.id = u.shop_id offset 0) s
      cross join lateral (select x.name from barbers x where x.id = u.barber_id offset 0) br
    ),
    'upcoming', (select count(*) from upcoming),
    'shops', coalesce((
      select jsonb_agg(jsonb_build_object(
               'shop_id', r.shop_id, 'name', r.name, 'slug', r.slug, 'time_zone', r.time_zone,
               'is_live', r.is_live,
               'opens_today', h.opens_today, 'closes_today', h.closes_today,
               'next_free_at', f.next_free_at,
               'last_visit_at', r.starts_at, 'service_id', r.service_id, 'service_name', r.service_name,
               'barber_id', r.barber_id, 'barber_name', r.barber_name,
               'visits', hb.visits,
               'usual_gap_days', case when hb.visits >= 2 then greatest(hb.median_gap, 7) else 28 end
             ) order by r.starts_at desc, r.shop_id)
      from recent r
      join habits hb on hb.shop_id = r.shop_id
      left join public.shops_hours_today((select ids from page)) h on h.shop_id = r.shop_id
      left join public.shops_next_free((select ids from page)) f on f.shop_id = r.shop_id
    ), '[]'::jsonb)
  ));
end;
$$;

-- Whole screens in one request ---------------------------------------------------

-- Everything a shop's page shows when it opens, in one answer, for anyone
-- (guests too). It sent the shop, then six requests at once, and their
-- round trips took far longer than the database's work (see README, "How
-- many users it handles"). The parts are what those requests gave, with
-- the same rows, fields and rules (booking_test.sql compares them), and
-- they all stay for everything else: the shop as select * gives it; its
-- active services and active barbers (each with their intro, stars and
-- hours), in the page's order; the days closed in the 14 the page offers
-- (shop_closed_days); today's hours (shop_hours_today) and the date they
-- are for; while the shop runs a queue, its count and wait with the
-- caller's own place (queue_status); the photos of its cuts, up to 24 in
-- the owner's order; and the newest reviews, three as the page shows them,
-- with whether there are more. The shop is there when the
-- caller can see it, as the shops policy says: live, or their own. Any
-- other shop gives only what shop_public_status gives, so its link can say
-- whose shop it is and that it isn't taking bookings; an unknown link gives
-- neither. plpgsql with a generic plan, so a connection plans it once. To
-- add a part, add a line to the last jsonb_build_object.
create function public.shop_page(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set plan_cache_mode = force_generic_plan
as $$
declare
  v_shop shops;
  v_today date;
  v_reviews jsonb;
  v_more boolean;
begin
  select * into v_shop
  from shops s
  where s.slug = p_slug and (public.shop_is_live(s) or s.owner_id = (select auth.uid()));
  if not found then
    return jsonb_build_object('shop', null, 'status', (
      select jsonb_build_object('name', s.name, 'phone', s.phone, 'is_live', public.shop_is_live(s))
      from shops s
      where s.slug = p_slug));
  end if;
  v_today := (now() at time zone v_shop.time_zone)::date;

  -- One more than the page shows, to know whether there are more. Read
  -- newest first straight off reviews_shop_created_idx.
  select coalesce(jsonb_agg(r.item order by r.n) filter (where r.n <= 3), '[]'::jsonb), count(*) > 3
    into v_reviews, v_more
  from (
    select row_number() over (order by r.created_at desc, r.booking_id) as n,
           jsonb_build_object(
             'booking_id', r.booking_id, 'rating', r.rating, 'comment', r.comment, 'first_name', r.first_name,
             'reply', r.reply, 'replied_at', r.replied_at, 'created_at', r.created_at,
             'barbers', jsonb_build_object('name', b.name)) as item
    from (
      select * from reviews r
      where r.shop_id = v_shop.id
      order by r.created_at desc, r.booking_id
      limit 4
    ) r
    join barbers b on b.id = r.barber_id
  ) r;

  return jsonb_build_object(
    'shop', to_jsonb(v_shop),
    'services', coalesce((
      select jsonb_agg(to_jsonb(v) order by v.sort_order, v.name, v.id)
      from services v
      where v.shop_id = v_shop.id and v.is_active
    ), '[]'::jsonb),
    'barbers', coalesce((
      select jsonb_agg(to_jsonb(b) || jsonb_build_object('working_hours', coalesce((
               select jsonb_agg(jsonb_build_object('weekday', wh.weekday, 'opens_at', wh.opens_at, 'closes_at', wh.closes_at)
                                order by wh.weekday, wh.opens_at)
               from working_hours wh
               where wh.barber_id = b.id
             ), '[]'::jsonb)) order by b.sort_order, b.name, b.id)
      from barbers b
      where b.shop_id = v_shop.id and b.is_active
    ), '[]'::jsonb),
    'today', v_today,
    'closed_days', coalesce((
      select jsonb_agg(to_jsonb(d) - 'ordinality' order by d.ordinality)
      from public.shop_closed_days(v_shop.id, v_today, v_today + 13) with ordinality d
    ), '[]'::jsonb),
    'hours_today', (select to_jsonb(h) from public.shop_hours_today(v_shop.id) h),
    'queue', case when v_shop.queue_enabled then public.queue_status(v_shop.id) end,
    -- Photos of the shop's cuts, first first, off shop_photos_shop_order_idx.
    'photos', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', ph.id, 'barber_id', ph.barber_id, 'caption', ph.caption, 'path', ph.path,
               'thumb_path', ph.thumb_path, 'width', ph.width, 'height', ph.height, 'sort_order', ph.sort_order
             ) order by ph.sort_order, ph.created_at, ph.id)
      from (
        select * from shop_photos ph
        where ph.shop_id = v_shop.id
        order by ph.sort_order, ph.created_at, ph.id
        limit 24
      ) ph
    ), '[]'::jsonb),
    'reviews', v_reviews,
    'more_reviews', v_more
  );
end;
$$;

-- Everything the barber's Bookings tab asks for on a day, on opening it and
-- on each minute's refresh, in one answer: it was seven requests, and the
-- tab's badge asked what customers changed alongside. Only the caller's own shop. The parts are what those requests gave, with the same
-- rows, fields and rules (booking_test.sql compares them), and they all
-- stay for everything else: the day's bookings with each one's barber and
-- customer, as the screen selects them; how many services customers can
-- book; every barber with their hours, away ones too; the closed days over
-- the day strip, yesterday to 13 days ahead (and the day itself, if it is
-- off the strip), as shop_closed_days gives them to the owner; on today,
-- tomorrow's bookings nobody has reminded yet and today's walk-in queue
-- (shop_queue, which is empty unless the queue is on or someone is still
-- in it); the day's waiting list (shop_waitlist); and what customers
-- changed since p_since, as shop_changes counts it with p_since and
-- p_limit. Each part is an index lookup bounded by the shop. plpgsql with a
-- generic plan, so a connection plans it once.
create function public.shop_day(p_day date, p_since timestamptz default null, p_limit int default 5)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set plan_cache_mode = force_generic_plan
as $$
declare
  v_shop shops;
  v_today date;
  v_tz text;
begin
  select * into v_shop from shops where owner_id = auth.uid();
  if not found then
    raise exception 'Set up your shop first.' using errcode = 'P0002';
  end if;
  v_tz := v_shop.time_zone;
  v_today := (now() at time zone v_tz)::date;

  return jsonb_build_object(
    'bookings', coalesce((
      select jsonb_agg(to_jsonb(b) || jsonb_build_object(
               'barbers', jsonb_build_object('name', br.name),
               'customer', case when p.id is not null then jsonb_build_object('full_name', p.full_name, 'phone', p.phone) end
             ) order by b.starts_at, b.id)
      from bookings b
      join barbers br on br.id = b.barber_id
      left join profiles p on p.id = b.customer_id
      where b.shop_id = v_shop.id
        and b.starts_at >= p_day::timestamp at time zone v_tz
        and b.starts_at < (p_day + 1)::timestamp at time zone v_tz
    ), '[]'::jsonb),
    'services', (select count(*)::int from services v where v.shop_id = v_shop.id and v.is_active),
    'barbers', coalesce((
      select jsonb_agg(to_jsonb(br) || jsonb_build_object('working_hours', coalesce((
               select jsonb_agg(to_jsonb(wh) order by wh.weekday, wh.opens_at)
               from working_hours wh
               where wh.barber_id = br.id
             ), '[]'::jsonb)) order by br.sort_order, br.created_at, br.id)
      from barbers br
      where br.shop_id = v_shop.id
    ), '[]'::jsonb),
    'closed', coalesce((
      select jsonb_agg(to_jsonb(d) - 'ordinality' order by d.ordinality)
      from public.shop_closed_days(v_shop.id, least(p_day, v_today - 1), greatest(p_day, v_today + 13)) with ordinality d
    ), '[]'::jsonb),
    'tomorrow', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id, 'barber_id', b.barber_id, 'status', b.status, 'is_block', b.is_block,
               'starts_at', b.starts_at, 'reminded_at', b.reminded_at, 'guest_phone', b.guest_phone,
               'created_at', b.created_at,
               'customer', case when p.id is not null then jsonb_build_object('phone', p.phone) end
             ) order by b.starts_at, b.id)
      from bookings b
      left join profiles p on p.id = b.customer_id
      where p_day = v_today
        and b.shop_id = v_shop.id
        and b.starts_at >= (v_today + 1)::timestamp at time zone v_tz
        and b.starts_at < (v_today + 2)::timestamp at time zone v_tz
        and b.status = 'confirmed'
        and not b.is_block
        and b.reminded_at is null
    ), '[]'::jsonb),
    'waiting', coalesce((
      select jsonb_agg(to_jsonb(w) - 'ordinality' order by w.ordinality)
      from public.shop_waitlist(p_day) with ordinality w
    ), '[]'::jsonb),
    'queue', case when p_day = v_today then coalesce((
      select jsonb_agg(to_jsonb(q) - 'ordinality' order by q.ordinality)
      from public.shop_queue() with ordinality q
    ), '[]'::jsonb) else '[]'::jsonb end,
    'changes', public.shop_changes(p_since, p_limit)
  );
end;
$$;

-- People can delete their own account (the app stores require it).
-- A customer's upcoming bookings are cancelled, and their past ones stay in
-- the shop's history without their name or phone. An owner's shop goes
-- with them, along with its barbers, services, bookings and photos (the
-- app removes the photos' files from Storage first, as only it can).
create function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  -- Cancelling the upcoming ones is the customer's change, so their shops see
  -- it. Under each shop's diary lock, like every other change to its bookings,
  -- so the times stamped follow the order they are saved in (see
  -- bookings.customer_changed_at). Always in the same order, so two of these
  -- can't wait on each other.
  for v_shop in
    select distinct shop_id from bookings
    where customer_id = auth.uid() and status = 'confirmed' and starts_at > now()
    order by shop_id
  loop
    perform public.lock_shop_diary(v_shop);
  end loop;

  update bookings set
    status = case when status = 'confirmed' and starts_at > now()
                  then 'cancelled'::booking_status else status end,
    customer_changed_at = case when status = 'confirmed' and starts_at > now()
                               then clock_timestamp() else customer_changed_at end,
    customer_change = case when status = 'confirmed' and starts_at > now()
                           then 'cancelled' else customer_change end,
    customer_id = null,
    guest_name = 'Deleted account',
    guest_phone = null,
    customer_note = null
  where customer_id = auth.uid();

  delete from auth.users where id = auth.uid();
end;
$$;

-- Someone who signed up as a barber by mistake, before making a shop, can
-- use the app as a customer instead. Owners of a shop can't: their shop
-- would be left without anyone to run it.
create function public.become_customer()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if exists (select 1 from shops where owner_id = auth.uid()) then
    raise exception 'You have a shop, so this account stays a barber account.' using errcode = 'P0001';
  end if;
  update profiles set role = 'customer' where id = auth.uid();
end;
$$;

revoke execute on function public.delete_my_account() from public, anon;
revoke execute on function public.my_bookings(int) from public, anon;
grant execute on function public.my_bookings(int) to authenticated;
revoke execute on function public.my_shops() from public, anon;
grant execute on function public.my_shops() to authenticated;
grant execute on function public.delete_my_account() to authenticated;
revoke execute on function public.become_customer() from public, anon;
grant execute on function public.become_customer() to authenticated;
revoke execute on function public.add_shop_booking(uuid, date, time, int, uuid, text, text, text, boolean) from public, anon;
grant execute on function public.add_shop_booking(uuid, date, time, int, uuid, text, text, text, boolean) to authenticated;
revoke execute on function public.book_appointment(uuid, timestamptz, uuid, text) from public, anon;
revoke execute on function public.set_booking_status(uuid, public.booking_status) from public, anon;
revoke execute on function public.mark_booking_reminded(uuid, timestamptz, boolean) from public, anon;
revoke execute on function public.reschedule_booking(uuid, timestamptz, uuid) from public, anon;
revoke execute on function public.set_barber_hours(uuid, jsonb) from public, anon;
grant execute on function public.book_appointment(uuid, timestamptz, uuid, text) to authenticated;
grant execute on function public.set_booking_status(uuid, public.booking_status) to authenticated;
grant execute on function public.mark_booking_reminded(uuid, timestamptz, boolean) to authenticated;
grant execute on function public.reschedule_booking(uuid, timestamptz, uuid) to authenticated;
grant execute on function public.set_barber_hours(uuid, jsonb) to authenticated;
revoke execute on function public.close_shop_days(date, int, text) from public, anon;
revoke execute on function public.reopen_shop_days(date, int) from public, anon;
grant execute on function public.close_shop_days(date, int, text) to authenticated;
grant execute on function public.reopen_shop_days(date, int) to authenticated;
revoke execute on function public.shop_summary(date, date) from public, anon;
grant execute on function public.shop_summary(date, date) to authenticated;
revoke execute on function public.shop_customers(text, int, int) from public, anon;
grant execute on function public.shop_customers(text, int, int) to authenticated;
revoke execute on function public.shop_changes(timestamptz, int) from public, anon;
grant execute on function public.shop_changes(timestamptz, int) to authenticated;
revoke execute on function public.shop_setup() from public, anon;
grant execute on function public.shop_setup() to authenticated;
revoke execute on function public.review_first_name(text) from public, anon, authenticated;
revoke execute on function public.rate_booking(uuid, int, text, text) from public, anon;
grant execute on function public.rate_booking(uuid, int, text, text) to authenticated;
revoke execute on function public.reply_to_review(uuid, text) from public, anon;
grant execute on function public.reply_to_review(uuid, text) to authenticated;
revoke execute on function public.max_waiting_per_customer() from public, anon, authenticated;
revoke execute on function public.join_waitlist(uuid, date, uuid) from public, anon;
grant execute on function public.join_waitlist(uuid, date, uuid) to authenticated;
revoke execute on function public.leave_waitlist(uuid) from public, anon;
grant execute on function public.leave_waitlist(uuid) to authenticated;
revoke execute on function public.mark_waitlist_offered(uuid) from public, anon;
grant execute on function public.mark_waitlist_offered(uuid) to authenticated;
revoke execute on function public.shop_waitlist(date) from public, anon;
grant execute on function public.shop_waitlist(date) to authenticated;
revoke execute on function public.my_waitlist() from public, anon;
grant execute on function public.my_waitlist() to authenticated;
revoke execute on function public.max_queue_waiting() from public, anon, authenticated;
revoke execute on function public.max_queue_joins_a_day() from public, anon, authenticated;
revoke execute on function public.queue_taken_off_shown() from public, anon, authenticated;
revoke execute on function public.barbers_in_now(uuid, text, boolean) from public, anon, authenticated;
revoke execute on function public.queue_estimate(bigint, int) from public, anon, authenticated;
revoke execute on function public.join_queue(uuid, uuid) from public, anon;
grant execute on function public.join_queue(uuid, uuid) to authenticated;
revoke execute on function public.leave_queue(uuid) from public, anon;
grant execute on function public.leave_queue(uuid) to authenticated;
revoke execute on function public.add_to_queue(text, text, uuid, uuid) from public, anon;
grant execute on function public.add_to_queue(text, text, uuid, uuid) to authenticated;
revoke execute on function public.call_from_queue(uuid) from public, anon;
grant execute on function public.call_from_queue(uuid) to authenticated;
revoke execute on function public.remove_from_queue(uuid) from public, anon;
grant execute on function public.remove_from_queue(uuid) to authenticated;
revoke execute on function public.start_from_queue(uuid, uuid, uuid) from public, anon;
grant execute on function public.start_from_queue(uuid, uuid, uuid) to authenticated;
revoke execute on function public.shop_queue() from public, anon;
grant execute on function public.shop_queue() to authenticated;
revoke execute on function public.my_queue() from public, anon;
grant execute on function public.my_queue() to authenticated;
revoke execute on function public.shop_day(date, timestamptz, int) from public, anon;
grant execute on function public.shop_day(date, timestamptz, int) to authenticated;
-- Booking links are opened by guests too, and so is a shop's queue count.
grant execute on function public.shop_public_status(text) to anon, authenticated;
revoke execute on function public.queue_status(uuid) from public;
grant execute on function public.queue_status(uuid) to anon, authenticated;
revoke execute on function public.shop_page(text) from public;
grant execute on function public.shop_page(text) to anon, authenticated;

-- Photos of the shop's cuts: the files ------------------------------------------

-- A public bucket, so the app shows each photo straight from Supabase's CDN,
-- with no signed links to ask for. Anyone with a file's link can open it, as
-- with any public bucket: a hidden shop's photos are only left out of the
-- lists, and their names are random. Raster images up to 2 MB (the app sends
-- JPEGs of a few hundred KB; no SVG, which can carry scripts). A shop's
-- owner writes only into its own folder, "<shop id>/...", and never over a
-- file: each photo is a new name. The app sends each with a day's cache time,
-- as the free plan's CDN keeps a removed file until that runs out.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shop-photos', 'shop-photos', true, 2 * 1024 * 1024, array['image/jpeg', 'image/png', 'image/webp']);

-- How many files the signed-in owner's shop folder holds, for the cap on
-- adding more: the 24 photos stop at rows, and without this a barber (with a
-- hidden shop, say) could fill the public bucket with files no photo lists.
-- Counted in a function, as a policy on storage.objects can't read that
-- table itself, and as a range of names ("<shop id>/" up to "<shop id>0",
-- '0' coming straight after '/' byte by byte) so it reads Supabase's index
-- on (bucket_id, name collate "C") for just that folder.
create function public.my_shop_photo_file_count()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from storage.objects o, (select public.my_shop_id()::text as id) shop
  where o.bucket_id = 'shop-photos'
    and o.name collate "C" >= shop.id || '/'
    and o.name collate "C" < shop.id || '0';
$$;
revoke execute on function public.my_shop_photo_file_count() from public, anon;
grant execute on function public.my_shop_photo_file_count() to authenticated;

-- At most 56 files: two for each of the 24 photos, and a few more for photos
-- on their way or files waiting to be cleared (scripts/clean-photos.mjs).
create policy "owners add photos to their shop's folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'shop-photos'
    and (storage.foldername(name))[1] = (select public.my_shop_id())::text
    and (select public.my_shop_photo_file_count()) < 2 * 24 + 8
  );
-- Supabase Storage reads the file's row before removing it, so the owner
-- needs to see their own; everyone else gets the files from the CDN.
create policy "owners see their shop's photo files" on storage.objects
  for select to authenticated
  using (bucket_id = 'shop-photos' and (storage.foldername(name))[1] = (select public.my_shop_id())::text);
create policy "owners remove photos from their shop's folder" on storage.objects
  for delete to authenticated
  using (bucket_id = 'shop-photos' and (storage.foldername(name))[1] = (select public.my_shop_id())::text);

-- Files in the bucket that no photo points at, a day after they came: left
-- by an upload whose photo was never saved (the phone lost signal, or the
-- shop had 24 by then), a removal whose files didn't go, or a shop deleted
-- outside the app. Deleting rows from storage.objects would leave the files
-- themselves behind, so scripts/clean-photos.mjs lists these and removes them
-- through the Storage API with the service role key, the only key that may
-- call this (see README, "Photos of the shop's cuts").
create function public.shop_photo_files_left_behind(p_limit int default 1000)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select o.name
  from storage.objects o
  where o.bucket_id = 'shop-photos'
    and o.created_at < now() - interval '1 day'
    and not exists (select 1 from shop_photos p where p.path = o.name)
    and not exists (select 1 from shop_photos p where p.thumb_path = o.name)
  order by o.created_at, o.name
  limit least(greatest(coalesce(p_limit, 1000), 1), 1000);
$$;
revoke execute on function public.shop_photo_files_left_behind(int) from public, anon, authenticated;
