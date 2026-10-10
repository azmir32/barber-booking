-- Malaysia-sized data for the load test: about 1,000 live shops with three
-- chairs each, 100,000 customers, and every chair booked through 90 days of
-- history and the next 30 days. Ids are derived from names (md5), so the
-- load script can find shops, barbers and customers without asking.
--
-- psql -v shops=1000 -v customers=100000 -f e2e/load/seed.sql

\if :{?shops} \else \set shops 1000 \endif
\if :{?customers} \else \set customers 100000 \endif

\echo › users and profiles
insert into auth.users (id, email, raw_user_meta_data)
select md5('owner' || i)::uuid, 'owner' || i || '@load.my',
       jsonb_build_object('role', 'barber', 'full_name', 'Owner ' || i, 'phone', '012-' || lpad(i::text, 7, '0'))
from generate_series(1, :shops) i;

insert into auth.users (id, email, raw_user_meta_data)
select md5('customer' || i)::uuid, 'customer' || i || '@load.my',
       jsonb_build_object('role', 'customer', 'full_name', 'Customer ' || i, 'phone', '011-' || lpad(i::text, 8, '0'))
from generate_series(1, :customers) i;

\echo › shops, chairs, services and hours
insert into public.shops (id, owner_id, name, slug, about, address, area, phone, is_published, subscription_status)
select md5('shop' || i)::uuid, md5('owner' || i)::uuid,
       'Kedai Gunting ' || i, 'kedai-gunting-' || i,
       'Fades, beard trims and kids cuts. Walk-ins welcome.',
       i || ', Jalan Utama, ' || area,
       area, '012-' || lpad(i::text, 7, '0'), true, 'active'
from generate_series(1, :shops) i,
     lateral (select (array['Kajang', 'Sungai Chua', 'Bangi', 'Semenyih', 'Cheras', 'Kuala Lumpur', 'Petaling Jaya',
                            'Shah Alam', 'Subang Jaya', 'Puchong', 'Klang', 'Seremban', 'Ipoh', 'Johor Bahru',
                            'George Town', 'Kota Bharu', 'Kuantan', 'Melaka', 'Alor Setar', 'Kuching'])[1 + i % 20] as area) a;

insert into public.barbers (id, shop_id, name, sort_order)
select md5('barber' || i || '-' || j)::uuid, md5('shop' || i)::uuid, 'Barber ' || j, j
from generate_series(1, :shops) i, generate_series(1, 3) j;

insert into public.services (id, shop_id, name, duration_min, price, sort_order)
select md5('service' || i || '-' || s.n)::uuid, md5('shop' || i)::uuid, s.name, s.minutes, s.price, s.n
from generate_series(1, :shops) i,
     (values (1, 'Haircut', 30, 20), (2, 'Skin fade', 45, 25), (3, 'Haircut + beard', 45, 30),
             (4, 'Beard trim', 15, 12), (5, 'Kids cut', 30, 15)) s(n, name, minutes, price);

insert into public.working_hours (barber_id, weekday, opens_at, closes_at)
select md5('barber' || i || '-' || j)::uuid, d, '10:00', '20:00'
from generate_series(1, :shops) i, generate_series(1, 3) j, generate_series(1, 6) d;

\echo › bookings (a few minutes)
-- Ten 30-minute cuts a day per chair, 45 minutes apart, Monday to Saturday.
-- History is mostly done; the coming month is about 60% full.
insert into public.bookings (shop_id, barber_id, service_id, customer_id, service_name, price,
                             starts_at, ends_at, status, created_at)
select md5('shop' || i)::uuid, md5('barber' || i || '-' || j)::uuid, md5('service' || i || '-1')::uuid,
       md5('customer' || (1 + floor(random() * :customers))::int)::uuid,
       'Haircut', 20, t, t + interval '30 minutes',
       (case when t > now() then (case when random() < 0.95 then 'confirmed' else 'cancelled' end)
             else (array['completed', 'completed', 'completed', 'completed', 'completed', 'completed',
                         'completed', 'completed', 'no_show', 'cancelled'])[1 + floor(random() * 10)::int] end
       )::public.booking_status,
       t - interval '3 days'
from generate_series(1, :shops) i,
     generate_series(1, 3) j,
     generate_series(-90, 30) d,
     generate_series(0, 9) k,
     lateral (select ((current_date + d) + time '10:00' + k * interval '45 minutes')
                     at time zone 'Asia/Kuala_Lumpur' as t) slot
where extract(dow from current_date + d) <> 0
  and (d <= 0 or random() < 0.6);

analyze;
\echo › done
