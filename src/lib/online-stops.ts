// A shop stopping a customer who keeps not turning up from booking in the
// app (stop_online_bookings in supabase/migrations). The customer is never
// told why: the shop just takes their bookings on WhatsApp.

/** What book_appointment, join_waitlist and join_queue say to someone the shop stopped. */
export const BOOK_ON_WHATSAPP = 'This shop takes your bookings on WhatsApp. Please message them there.';

/** What reschedule_booking says when that customer moves a booking themselves. Cancelling still works. */
export const MOVE_ON_WHATSAPP = 'Please WhatsApp the shop to change this booking. You can still cancel it.';

/** No-shows at a shop from which marking another one offers to stop them booking online. */
export const REPEAT_NO_SHOWS = 2;
