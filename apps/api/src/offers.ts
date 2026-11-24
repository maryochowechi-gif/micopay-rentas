import { randomBytes } from 'node:crypto';
import { isAvailable, BookingError } from './bookings.js';
import type { Queryable } from './db.js';
import { chainTimes, chainTiers, nightsBetween, quote, type Policy } from './quote.js';

export async function createOffer(
  db: Queryable,
  input: { listingId: number; hostId: number; checkIn: string; checkOut: string; guests: number },
  offerHours: number,
  daySecs: number,
) {
  const listing = (await db.query<{
    id: number; host_id: number; title: string; area: string; nightly_mxn: string; cleaning_mxn: string;
    deposit_mxn: string; max_guests: number; policy: Policy; host_name: string; host_address: string;
  }>(
    `SELECT l.*, u.name AS host_name, u.stellar_address AS host_address FROM listings l
     JOIN users u ON u.id = l.host_id WHERE l.id = $1 AND l.host_id = $2 AND u.role = 'host' FOR UPDATE OF l`,
    [input.listingId, input.hostId],
  )).rows[0];
  if (!listing) throw new BookingError('Listing not found for this host');
  const nights = nightsBetween(input.checkIn, input.checkOut);
  if (!(nights >= 1 && nights <= 30)) throw new BookingError('A stay is 1 to 30 nights');
  if (input.guests < 1 || input.guests > listing.max_guests) throw new BookingError(`This place takes up to ${listing.max_guests} guests`);
  const times = chainTimes(input.checkIn, input.checkOut);
  if (times.checkInSec <= Date.now() / 1000 + 30) throw new BookingError('Check-in must be in the future');
  if (!(await isAvailable(db, listing.id, input.checkIn, input.checkOut))) throw new BookingError('Those dates are already booked');
  if (!(Number.isFinite(offerHours) && offerHours > 0 && Number.isFinite(daySecs) && daySecs > 0)) throw new Error('Invalid payment link expiry configuration');

  const q = quote(listing, nights);
  const expiry = new Date(Date.now() + offerHours / 24 * daySecs * 1000).toISOString();
  const code = randomBytes(24).toString('base64url');
  await db.query(
    `INSERT INTO rental_offers
      (code, listing_id, host_id, check_in, check_out, nights, guests, nightly_mxn, cleaning_mxn, subtotal_mxn,
       fee_mxn, deposit_mxn, total_mxn, policy, tiers, status, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'open',$16)`,
    [code, listing.id, listing.host_id, input.checkIn, input.checkOut, nights, input.guests, q.nightly, q.cleaning, q.subtotal,
      q.fee, q.deposit, q.total, listing.policy, JSON.stringify(chainTiers(listing.policy)), expiry],
  );
  return { code, expires_at: expiry };
}
