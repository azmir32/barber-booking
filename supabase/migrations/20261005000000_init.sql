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
  phone text check (length(phone) <= 20),
  instagram text check (length(instagram) <= 60),
  time_zone text not null default 'Asia/Kuala_Lumpur',
  is_published boolean not null default false,
  -- Billing: every shop starts with a one-month free trial. Until payments are
  -- built, an admin sets subscription_status = 'active' by hand.
  trial_ends_at timestamptz not null default now() + interval '30 days',
  subscription_status text not null default 'trialing'
    check (subscription_status in ('trialing', 'active', 'past_due', 'cancelled')),
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

-- The signed-in barber's shop (an owner has at most one), or null. Policies
-- call it as (select public.my_shop_id()) so Postgres works it out once per
-- query instead of once per row, and can use the shop_id indexes.
create function public.my_shop_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from shops where owner_id = auth.uid();
$$;

-- Barbers (one per chair) ---------------------------------------------------

create table public.barbers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 40),
  is_active boolean not null default true,
  sort_order int not null default 0,
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
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (is_block or customer_id is not null or guest_name is not null),
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

-- Days the whole shop is shut, like Hari Raya. Kept apart from the barbers'
-- own blocks so reopening never touches them, and so a barber who joins
-- later is closed on those days too.
create table public.shop_closures (
  shop_id uuid not null references public.shops (id) on delete cascade,
  day date not null,
  reason text check (length(reason) <= 80),
  primary key (shop_id, day)
);

-- Row level security --------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.shops enable row level security;
alter table public.barbers enable row level security;
alter table public.services enable row level security;
alter table public.working_hours enable row level security;
alter table public.bookings enable row level security;
-- No policies: read and written only through the functions below.
alter table public.shop_closures enable row level security;

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

-- Users can't change their own role or billing fields from the app.
revoke update on public.profiles from anon, authenticated;
grant update (full_name, phone) on public.profiles to authenticated;
revoke insert, update on public.shops from anon, authenticated;
grant insert (owner_id, name, slug, about, address, area, phone, instagram, is_published)
  on public.shops to authenticated;
grant update (name, slug, about, address, area, phone, instagram, is_published)
  on public.shops to authenticated;
revoke insert, update, delete on public.bookings from anon, authenticated;
revoke insert, update, delete on public.shop_closures from anon, authenticated;

-- Finding a barber ----------------------------------------------------------

-- A shop's hours today by its own clock: the first barber in to the last one
-- out, leaving out barbers with the whole day off. Nulls when nobody is in,
-- or the shop is closed for the day. Breaks are ignored. plpgsql, so today's
-- bounds are known before the bookings lookup: as one SQL query the planner
-- read every booking the barbers ever had, and the shop list took 23 ms
-- instead of 2.5 ms (e2e/load).
create function public.shop_hours_today(p_shop_id uuid)
returns table (opens_today time, closes_today time)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tz text;
  v_day date;
begin
  select s.time_zone into v_tz
  from shops s
  where s.id = p_shop_id and (public.shop_is_live(s) or s.owner_id = (select auth.uid()));
  if not found then
    return query select null::time, null::time;
    return;
  end if;
  v_day := (now() at time zone v_tz)::date;
  return query
  select min(wh.opens_at), max(wh.closes_at)
  from barbers b
  join working_hours wh on wh.barber_id = b.id and wh.weekday = extract(dow from v_day)::int
  where b.shop_id = p_shop_id
    and b.is_active
    and not exists (select 1 from shop_closures c where c.shop_id = p_shop_id and c.day = v_day)
    and b.id not in (
      select bk.barber_id from bookings bk
      where bk.shop_id = p_shop_id
        and bk.starts_at >= v_day::timestamp at time zone v_tz
        and bk.starts_at < (v_day + 1)::timestamp at time zone v_tz
        and bk.is_block
        and bk.status = 'confirmed'
        and bk.ends_at - bk.starts_at >= interval '24 hours'
    );
end;
$$;

-- When someone wanting a cut soon could get one: the earliest free start for
-- the shop's shortest service with any barber, today by the shop's clock or
-- else tomorrow. Null when neither day has a free time. It gives the same
-- answer as the earliest of available_slots (booking_test.sql checks), but
-- find_shops runs it for every shop on a page, so rather than trying every
-- start time it only tries the few that can be first: free times sit on a
-- 15-minute grid from opening, so the first one is the first grid time after
-- now, or the first after one of the barber's bookings ends. That halves the
-- shop list's time (e2e/load).
create function public.shop_next_free(p_shop_id uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tz text;
  v_minutes int;
  v_day date;
  v_at timestamptz;
begin
  select s.time_zone into v_tz
  from shops s
  where s.id = p_shop_id and (public.shop_is_live(s) or s.owner_id = (select auth.uid()));
  select v.duration_min into v_minutes
  from services v
  where v.shop_id = p_shop_id and v.is_active
  order by v.duration_min, v.sort_order, v.id
  limit 1;
  if v_tz is null or v_minutes is null then
    return null;
  end if;

  v_day := (now() at time zone v_tz)::date;
  -- Tomorrow is only worked out when today has nothing left. Both are well
  -- inside the booking horizon.
  for i in 0..1 loop
    if not exists (select 1 from shop_closures c where c.shop_id = p_shop_id and c.day = v_day) then
      with hours as (
        select b.id as barber_id,
               (v_day + wh.opens_at) at time zone v_tz as opens,
               (v_day + wh.closes_at) at time zone v_tz as closes
        from barbers b
        join working_hours wh on wh.barber_id = b.id and wh.weekday = extract(dow from v_day)::int
        where b.shop_id = p_shop_id and b.is_active
      ),
      taken as materialized (
        -- Bookings and blocks are at most a day long, so anything in the way
        -- started after the day before began.
        select bk.barber_id, bk.starts_at, bk.ends_at
        from bookings bk
        where bk.shop_id = p_shop_id
          and bk.status <> 'cancelled'
          and bk.starts_at > (v_day - 1)::timestamp at time zone v_tz
          and bk.starts_at < (v_day + 1)::timestamp at time zone v_tz
      ),
      tries as materialized (
        -- Each point rounded up to the grid; the microsecond keeps a grid time
        -- that is exactly now out, as available_slots does.
        select h.barber_id, h.closes,
               date_bin('15 minutes', p.at + interval '15 minutes' - interval '1 microsecond', h.opens) as at
        from hours h
        cross join lateral (
          select greatest(h.opens, now() + interval '1 microsecond') as at
          union all
          select greatest(t.ends_at, h.opens, now() + interval '1 microsecond')
          from taken t
          where t.barber_id = h.barber_id and t.ends_at > h.opens and t.ends_at < h.closes
        ) p
      )
      select min(tr.at) into v_at
      from tries tr
      where tr.at + make_interval(mins => v_minutes) <= tr.closes
        and not exists (
          select 1 from taken t
          where t.barber_id = tr.barber_id
            and t.starts_at < tr.at + make_interval(mins => v_minutes)
            and t.ends_at > tr.at
        );
      if v_at is not null then
        return v_at;
      end if;
    end if;
    v_day := v_day + 1;
  end loop;
  return null;
end;
$$;
-- Only find_shops uses it.
revoke execute on function public.shop_next_free(uuid) from public, anon, authenticated;

-- The customer's shop list: live shops whose name, area or address contains
-- the search, a page at a time, with each shop's lowest price, number of
-- chairs, today's hours (first barber in to last one out, in the shop's
-- time zone; breaks and blocked time are not counted, and both are null
-- when nobody works today) and its next free time. Sending every shop with
-- all its services and barbers came to 570 KB for 1,000 shops (e2e/load).
create function public.find_shops(
  p_search text default null,
  p_area text default null,
  p_limit int default 20,
  p_offset int default 0
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
  next_free_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  -- The page is picked first, so today's hours and the next free time are
  -- only worked out for the shops sent back.
  select p.id, p.name, p.slug, p.area, p.address, p.about, p.from_price, p.barber_count,
         h.opens_today, h.closes_today, public.shop_next_free(p.id)
  from (
    select s.id, s.name, s.slug, s.area, s.address, s.about, s.time_zone,
           (select min(v.price) from services v where v.shop_id = s.id and v.is_active) as from_price,
           (select count(*)::int from barbers b where b.shop_id = s.id and b.is_active) as barber_count
    from shops s
    where public.shop_is_live(s)
      and (coalesce(trim(p_area), '') = '' or lower(s.area) = lower(trim(p_area)))
      and (
        coalesce(trim(p_search), '') = ''
        or strpos(lower(s.name || ' ' || s.area || ' ' || coalesce(s.address, '')), lower(trim(p_search))) > 0
      )
    order by lower(s.name), s.id
    limit least(greatest(coalesce(p_limit, 20), 1), 50)
    offset greatest(coalesce(p_offset, 0), 0)
  ) p
  left join lateral public.shop_hours_today(p.id) h on true
  order by lower(p.name), p.id;
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
-- are typed by barbers, so spellings that differ only in case count as one.
create function public.shop_areas()
returns table (area text, shops int)
language sql
stable
security definer
set search_path = public
as $$
  select mode() within group (order by s.area), count(*)::int
  from shops s
  where public.shop_is_live(s)
  group by lower(s.area)
  order by count(*) desc, lower(s.area);
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
      starts_at, ends_at, customer_note
    ) values (
      v_service.shop_id, v_barber, v_service.id, v_uid, v_service.name, v_service.price,
      p_starts_at, p_starts_at + make_interval(mins => v_service.duration_min),
      nullif(trim(p_note), '')
    )
    returning * into v_booking;
  exception when exclusion_violation then
    raise exception 'Sorry, that time was just taken. Please pick another.' using errcode = 'P0001';
  end;

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
  else
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;

  perform public.lock_shop_diary(v_booking.shop_id);
  begin
    update bookings set status = p_status where id = p_booking_id returning * into v_booking;
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
-- Customers move their own upcoming bookings. The new time follows the same rules as
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
begin
  -- Lock before reading, so nobody cancels or moves it in between.
  perform public.lock_shop_diary(shop_id) from bookings where id = p_booking_id;
  select * into v_booking from bookings where id = p_booking_id;
  if not found or v_booking.is_block then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;

  if v_booking.customer_id is distinct from auth.uid() then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;
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
      reminded_at = null
    where id = v_booking.id
    returning * into v_booking;
  exception when exclusion_violation then
    raise exception 'Sorry, that time was just taken. Please pick another.' using errcode = 'P0001';
  end;

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
  if exists (
    select 1 from bookings
    where shop_id = v_shop.id
      and not is_block
      and status = 'confirmed'
      and ends_at > now()
      and starts_at < (p_from + p_days)::timestamp at time zone v_shop.time_zone
      and ends_at > p_from::timestamp at time zone v_shop.time_zone
  ) then
    raise exception 'There are bookings on those days. Cancel them first (and let the customers know), then close the shop.'
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
-- closed the shop, and days every barber has the whole day off. Only the
-- owner sees the reason. is_closure marks the first kind, which Reopen undoes.
create function public.shop_closed_days(p_shop_id uuid, p_from date, p_to date)
returns table (day date, reason text, is_closure boolean)
language sql
stable
security definer
set search_path = public
as $$
  with shop as (
    select sh.id, sh.time_zone, sh.owner_id = (select auth.uid()) as mine,
           least(p_to, p_from + 90) as last_day
    from shops sh
    where sh.id = p_shop_id and (public.shop_is_live(sh) or sh.owner_id = (select auth.uid()))
  ),
  team as (
    select count(*) as n from barbers b join shop on b.shop_id = shop.id where b.is_active
  ),
  all_off as (
    select (bk.starts_at at time zone shop.time_zone)::date as day,
           count(distinct bk.barber_id) as n,
           min(bk.service_name) as reason
    from bookings bk
    join shop on bk.shop_id = shop.id
    join barbers b on b.id = bk.barber_id and b.is_active
    where bk.is_block
      and bk.status = 'confirmed'
      and bk.ends_at - bk.starts_at >= interval '24 hours'
      and bk.starts_at >= p_from::timestamp at time zone shop.time_zone
      and bk.starts_at < (shop.last_day + 1)::timestamp at time zone shop.time_zone
    group by 1
  )
  select c.day, case when shop.mine then c.reason end, true
  from shop_closures c join shop on c.shop_id = shop.id
  where c.day between p_from and shop.last_day
  union all
  select a.day, case when shop.mine then a.reason end, false
  from all_off a, team, shop
  where a.n = team.n and team.n > 0
    and not exists (select 1 from shop_closures c where c.shop_id = shop.id and c.day = a.day)
  order by 1;
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
-- matches, not just the page, so My shop asks for a single row to show them.
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

-- A customer's own bookings, newest first, each with its shop and barber.
-- Customers can only read live shops (and their barbers), so a plain select
-- of bookings with shops(...) lost the shop's name, address and phone the
-- moment it paused: the booking still stood, but the customer no longer knew
-- where to go or how to reach the shop. is_live says whether it still takes
-- online bookings, so the app can hide Change time and say why.
create function public.my_bookings(p_limit int default 100)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(x.item order by x.starts_at desc, x.id), '[]'::jsonb)
  from (
    select b.id, b.starts_at,
           to_jsonb(b) || jsonb_build_object(
             'shops', jsonb_build_object(
               'name', s.name, 'slug', s.slug, 'address', s.address, 'area', s.area,
               'phone', s.phone, 'time_zone', s.time_zone, 'is_live', public.shop_is_live(s)),
             'barbers', jsonb_build_object('name', br.name)) as item
    from bookings b
    join shops s on s.id = b.shop_id
    join barbers br on br.id = b.barber_id
    where b.customer_id = auth.uid()
    order by b.starts_at desc, b.id
    limit least(greatest(coalesce(p_limit, 100), 1), 200)
  ) x;
$$;

-- People can delete their own account (the app stores require it).
-- A customer's upcoming bookings are cancelled, and their past ones stay in
-- the shop's history without their name or phone. An owner's shop goes
-- with them, along with its barbers, services and bookings.
create function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  update bookings set
    status = case when status = 'confirmed' and starts_at > now()
                  then 'cancelled'::booking_status else status end,
    customer_id = null,
    guest_name = 'Deleted account',
    guest_phone = null,
    customer_note = null
  where customer_id = auth.uid();

  delete from auth.users where id = auth.uid();
end;
$$;

revoke execute on function public.delete_my_account() from public, anon;
revoke execute on function public.my_bookings(int) from public, anon;
grant execute on function public.my_bookings(int) to authenticated;
grant execute on function public.delete_my_account() to authenticated;
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
-- Booking links are opened by guests too.
grant execute on function public.shop_public_status(text) to anon, authenticated;
