// Row shapes for the tables in supabase/migrations.

export type Role = 'customer' | 'barber';
export type BookingStatus = 'confirmed' | 'cancelled' | 'completed' | 'no_show';

export type Profile = {
  id: string;
  role: Role;
  full_name: string;
  phone: string | null;
};

export type Shop = {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  about: string | null;
  address: string | null;
  area: string;
  phone: string | null;
  instagram: string | null;
  time_zone: string;
  is_published: boolean;
  trial_ends_at: string;
  subscription_status: 'trialing' | 'active' | 'past_due' | 'cancelled';
};

export type Barber = {
  id: string;
  shop_id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
};

export type Service = {
  id: string;
  shop_id: string;
  name: string;
  duration_min: number;
  price: number;
  is_active: boolean;
  sort_order: number;
};

export type WorkingHours = {
  id: string;
  barber_id: string;
  weekday: number;
  opens_at: string;
  closes_at: string;
};

export type Booking = {
  id: string;
  shop_id: string;
  barber_id: string;
  service_id: string | null;
  /** Null for bookings the shop added itself and for blocked time. */
  customer_id: string | null;
  guest_name: string | null;
  guest_phone: string | null;
  is_block: boolean;
  service_name: string;
  price: number;
  starts_at: string;
  ends_at: string;
  status: BookingStatus;
  customer_note: string | null;
};

export type Slot = { barber_id: string; starts_at: string };

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
