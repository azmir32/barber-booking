-- My bookings keeps each booking's shop and barber when the shop is paused or
-- its trial has ended, and everyone has a name.

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

revoke execute on function public.my_bookings(int) from public, anon;
grant execute on function public.my_bookings(int) to authenticated;

-- A blank name left the barber with a booking from nobody, and the
-- customer's WhatsApp messages read "this is ." Not valid, so a blank name
-- already saved doesn't stop the migration; the next change to it must fix it.
alter table public.profiles
  add constraint profiles_full_name_not_blank check (length(trim(full_name)) > 0) not valid;

-- The app always sends a name at sign-up. An account made another way (say,
-- by hand in the Supabase dashboard) is named after its email instead, so it
-- can still be created.
create or replace function public.handle_new_user()
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
