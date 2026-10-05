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
  full_name text not null default '',
  phone text,
  created_at timestamptz not null default now()
);

-- Create a profile whenever someone signs up. The app passes role, full_name
-- and phone in the sign-up metadata.
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
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'phone', '')
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
  name text not null check (length(trim(name)) > 0),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  about text,
  address text,
  area text not null default 'Kajang',
  phone text,
  instagram text,
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

create function public.shop_visible(p_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from shops s
    where s.id = p_shop_id and (public.shop_is_live(s) or s.owner_id = auth.uid())
  );
$$;

-- Barbers (one per chair) ---------------------------------------------------

create table public.barbers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index barbers_shop_id_idx on public.barbers (shop_id);

-- Services ------------------------------------------------------------------

create table public.services (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  duration_min int not null check (duration_min between 5 and 480),
  price numeric(10, 2) not null check (price >= 0),
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
  check (closes_at > opens_at)
);
create index working_hours_barber_id_idx on public.working_hours (barber_id);

-- Bookings ------------------------------------------------------------------

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  barber_id uuid not null references public.barbers (id) on delete cascade,
  service_id uuid references public.services (id) on delete set null,
  customer_id uuid not null references public.profiles (id) on delete cascade,
  -- Snapshot of the service at booking time, so later price edits don't
  -- rewrite history.
  service_name text not null,
  price numeric(10, 2) not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status public.booking_status not null default 'confirmed',
  customer_note text,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  -- A barber can never be double-booked.
  constraint bookings_no_overlap exclude using gist (
    barber_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status <> 'cancelled')
);
create index bookings_shop_starts_idx on public.bookings (shop_id, starts_at);
create index bookings_customer_idx on public.bookings (customer_id, starts_at);

-- Row level security --------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.shops enable row level security;
alter table public.barbers enable row level security;
alter table public.services enable row level security;
alter table public.working_hours enable row level security;
alter table public.bookings enable row level security;

create policy "read own profile" on public.profiles
  for select using (id = auth.uid());
create policy "shop owners read their customers" on public.profiles
  for select using (
    exists (
      select 1 from public.bookings b
      where b.customer_id = profiles.id and public.owns_shop(b.shop_id)
    )
  );
create policy "update own profile" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

create policy "read live or own shops" on public.shops
  for select using (public.shop_is_live(shops) or owner_id = auth.uid());
create policy "barbers create their shop" on public.shops
  for insert with check (
    owner_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'barber')
  );
create policy "owners update their shop" on public.shops
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "read barbers of visible shops" on public.barbers
  for select using (public.shop_visible(shop_id));
create policy "owners manage barbers" on public.barbers
  for all using (public.owns_shop(shop_id)) with check (public.owns_shop(shop_id));

create policy "read services of visible shops" on public.services
  for select using (public.shop_visible(shop_id));
create policy "owners manage services" on public.services
  for all using (public.owns_shop(shop_id)) with check (public.owns_shop(shop_id));

create policy "read hours of visible shops" on public.working_hours
  for select using (
    exists (select 1 from public.barbers b where b.id = barber_id and public.shop_visible(b.shop_id))
  );
create policy "owners manage hours" on public.working_hours
  for all using (
    exists (select 1 from public.barbers b where b.id = barber_id and public.owns_shop(b.shop_id))
  ) with check (
    exists (select 1 from public.barbers b where b.id = barber_id and public.owns_shop(b.shop_id))
  );

-- Bookings are read directly but only written through the functions below.
create policy "customers and shop owners read bookings" on public.bookings
  for select using (customer_id = auth.uid() or public.owns_shop(shop_id));

-- Users can't change their own role or billing fields from the app.
revoke update on public.profiles from anon, authenticated;
grant update (full_name, phone) on public.profiles to authenticated;
revoke update on public.shops from anon, authenticated;
grant update (name, slug, about, address, area, phone, instagram, is_published)
  on public.shops to authenticated;
revoke insert, update, delete on public.bookings from anon, authenticated;

-- Availability --------------------------------------------------------------

-- Free start times for a service on a given local day, per barber.
-- Slots start every 15 minutes inside each barber's working hours, skip
-- anything already booked, and skip times that have already passed.
create function public.available_slots(
  p_service_id uuid,
  p_day date,
  p_barber_id uuid default null
)
returns table (barber_id uuid, starts_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  with svc as (
    select s.id, s.shop_id, s.duration_min, sh.time_zone
    from services s
    join shops sh on sh.id = s.shop_id
    where s.id = p_service_id
      and s.is_active
      and (public.shop_is_live(sh) or sh.owner_id = auth.uid())
  ),
  candidates as (
    select b.id as barber_id,
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
  )
  select c.barber_id, c.starts_at
  from candidates c
  where c.starts_at > now()
    and not exists (
      select 1 from bookings bk
      where bk.barber_id = c.barber_id
        and bk.status <> 'cancelled'
        and tstzrange(bk.starts_at, bk.ends_at)
            && tstzrange(c.starts_at, c.starts_at + make_interval(mins => c.duration_min))
    )
  order by c.starts_at, c.barber_id;
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

  select time_zone into v_tz from shops where id = v_service.shop_id;
  v_day := (p_starts_at at time zone v_tz)::date;

  select a.barber_id into v_barber
  from public.available_slots(p_service_id, v_day, p_barber_id) a
  where a.starts_at = p_starts_at
  order by (
    select count(*) from bookings bk
    where bk.barber_id = a.barber_id
      and bk.status <> 'cancelled'
      and (bk.starts_at at time zone v_tz)::date = v_day
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
-- bookings; shop owners may set any status on their shop's bookings.
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
    null;
  elsif v_booking.customer_id = auth.uid() then
    if p_status <> 'cancelled' or v_booking.status <> 'confirmed' or v_booking.starts_at <= now() then
      raise exception 'You can only cancel an upcoming booking.' using errcode = '42501';
    end if;
  else
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;

  update bookings set status = p_status where id = p_booking_id returning * into v_booking;
  return v_booking;
end;
$$;

revoke execute on function public.book_appointment(uuid, timestamptz, uuid, text) from public, anon;
revoke execute on function public.set_booking_status(uuid, public.booking_status) from public, anon;
grant execute on function public.book_appointment(uuid, timestamptz, uuid, text) to authenticated;
grant execute on function public.set_booking_status(uuid, public.booking_status) to authenticated;
