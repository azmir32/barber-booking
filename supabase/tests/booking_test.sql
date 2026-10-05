-- Behaviour tests for the booking schema. Run with: npm run test:db
-- Each check raises an exception on failure; the script stops at the first one.
\set ON_ERROR_STOP 1
\set QUIET 1

-- People ---------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000b1', 'owner@test', '{"role":"barber","full_name":"Ali","phone":"0123456789"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'cust1@test', '{"role":"customer","full_name":"Ben"}'),
  ('00000000-0000-0000-0000-0000000000c2', 'cust2@test', '{"full_name":"Chong"}');

do $$ begin
  assert (select role from profiles where id = '00000000-0000-0000-0000-0000000000b1') = 'barber',
    'barber sign-up should create a barber profile';
  assert (select role from profiles where id = '00000000-0000-0000-0000-0000000000c2') = 'customer',
    'sign-up without a role should default to customer';
end $$;

-- The owner sets up a shop ----------------------------------------------------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;

insert into shops (id, owner_id, name, slug)
values ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000b1', 'Ali Cuts', 'ali-cuts');
insert into barbers (id, shop_id, name) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000005a', 'Ali'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000005a', 'Danial');
insert into services (id, shop_id, name, duration_min, price)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000005a', 'Haircut', 30, 25);
-- Both barbers work 09:00-12:00 every day.
insert into working_hours (barber_id, weekday, opens_at, closes_at)
select b, d, '09:00', '12:00'
from unnest(array['00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2']::uuid[]) b,
     generate_series(0, 6) d;

do $$ begin
  update shops set subscription_status = 'active';
  raise exception 'owner should not be able to change billing fields';
exception when insufficient_privilege then null;
end $$;

-- A customer can't see an unpublished shop ----------------------------------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';

do $$ begin
  assert (select count(*) from shops) = 0, 'unpublished shop should be hidden from customers';
  assert (select count(*) from services) = 0, 'unpublished shop services should be hidden';
  assert (select count(*) from available_slots('00000000-0000-0000-0000-0000000000e1',
          (now() at time zone 'Asia/Kuala_Lumpur')::date + 1)) = 0,
    'unpublished shop should have no slots';
end $$;

do $$ begin
  insert into shops (owner_id, name, slug) values ('00000000-0000-0000-0000-0000000000c1', 'Nope', 'nope');
  raise exception 'customers should not be able to create shops';
exception when insufficient_privilege then null;
end $$;

-- Publish, then customers can see and book ---------------------------------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
update shops set is_published = true;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';

do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 1;
  ten timestamptz := (d + time '10:00') at time zone 'Asia/Kuala_Lumpur';
  b bookings;
begin
  assert (select count(*) from shops) = 1, 'published shop should be visible';
  -- 09:00..11:30 every 15 min = 11 start times per barber.
  assert (select count(*) from available_slots('00000000-0000-0000-0000-0000000000e1', d,
          '00000000-0000-0000-0000-0000000000a1')) = 11, 'expected 11 slots for one barber';
  assert (select count(*) from available_slots('00000000-0000-0000-0000-0000000000e1', d)) = 22,
    'expected 22 slots across both barbers';

  b := book_appointment('00000000-0000-0000-0000-0000000000e1', ten, '00000000-0000-0000-0000-0000000000a1', 'fade please');
  assert b.barber_id = '00000000-0000-0000-0000-0000000000a1', 'should book the chosen barber';
  assert b.ends_at = ten + interval '30 minutes', 'booking should last the service duration';
  assert b.price = 25 and b.service_name = 'Haircut', 'booking should snapshot the service';

  -- 09:45, 10:00 and 10:15 now overlap Ali's 10:00-10:30 booking.
  assert (select count(*) from available_slots('00000000-0000-0000-0000-0000000000e1', d,
          '00000000-0000-0000-0000-0000000000a1')) = 8, 'overlapping slots should disappear';

  -- "Any barber" at 10:00 goes to the free barber.
  b := book_appointment('00000000-0000-0000-0000-0000000000e1', ten);
  assert b.barber_id = '00000000-0000-0000-0000-0000000000a2', 'any-barber booking should pick the free barber';

  -- Now nobody is free at 10:00.
  begin
    perform book_appointment('00000000-0000-0000-0000-0000000000e1', ten);
    raise exception 'double booking should fail';
  exception when sqlstate 'P0001' then null;
  end;

  -- Off-grid or out-of-hours times are rejected.
  begin
    perform book_appointment('00000000-0000-0000-0000-0000000000e1', ten + interval '7 minutes');
    raise exception 'off-grid booking should fail';
  exception when sqlstate 'P0001' then null;
  end;
  begin
    perform book_appointment('00000000-0000-0000-0000-0000000000e1', (d + time '11:45') at time zone 'Asia/Kuala_Lumpur');
    raise exception 'booking past closing should fail';
  exception when sqlstate 'P0001' then null;
  end;
end $$;

-- Customers can't write bookings directly or see other people's -----------
do $$ begin
  insert into bookings (shop_id, barber_id, customer_id, service_name, price, starts_at, ends_at)
  values ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1',
          '00000000-0000-0000-0000-0000000000c1', 'x', 0, now() + interval '1 day', now() + interval '1 day 1 hour');
  raise exception 'direct booking inserts should be blocked';
exception when insufficient_privilege then null;
end $$;

do $$ begin
  update profiles set role = 'barber' where id = auth.uid();
  raise exception 'customers should not be able to change their role';
exception when insufficient_privilege then null;
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c2';
do $$
declare v_id uuid;
begin
  assert (select count(*) from bookings) = 0, 'customers should not see other people''s bookings';
  reset role;
  select id into v_id from bookings limit 1;
  set role authenticated;
  begin
    perform set_booking_status(v_id, 'cancelled');
    raise exception 'customers should not cancel other people''s bookings';
  exception when sqlstate 'P0002' then null;
  end;
end $$;

-- Customer cancels their own booking, freeing the slot -----------------------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 1;
  v_id uuid;
begin
  assert (select count(*) from bookings) = 2, 'customer should see their own bookings';
  select id into v_id from bookings where barber_id = '00000000-0000-0000-0000-0000000000a1';
  perform set_booking_status(v_id, 'cancelled');
  assert (select count(*) from available_slots('00000000-0000-0000-0000-0000000000e1', d,
          '00000000-0000-0000-0000-0000000000a1')) = 11, 'cancelling should free the slot';
  begin
    perform set_booking_status(v_id, 'completed');
    raise exception 'customers should only be able to cancel';
  exception when sqlstate '42501' then null;
  end;
end $$;

-- The owner sees all shop bookings and the customer's name ------------------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare v_id uuid;
begin
  assert (select count(*) from bookings) = 2, 'owner should see all shop bookings';
  assert (select full_name from profiles where id = '00000000-0000-0000-0000-0000000000c1') = 'Ben',
    'owner should see their customer''s name';
  assert (select count(*) from profiles where id = '00000000-0000-0000-0000-0000000000c2') = 0,
    'owner should not see unrelated customers';
  select id into v_id from bookings where status = 'confirmed';
  perform set_booking_status(v_id, 'no_show');
  assert (select status from bookings where id = v_id) = 'no_show', 'owner should mark no-shows';
end $$;

-- An expired trial hides the shop ---------------------------------------------
reset role;
update shops set trial_ends_at = now() - interval '1 day';
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
set role authenticated;
do $$ begin
  assert (select count(*) from shops) = 0, 'shop with expired trial should be hidden';
end $$;
reset role;
update shops set subscription_status = 'active';
set role authenticated;
do $$ begin
  assert (select count(*) from shops) = 1, 'paid shop should be visible again';
end $$;

reset role;
\echo 'All booking tests passed.'
