import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Horizon, Keypair } from '@stellar/stellar-sdk';
import { act, BookingError, createBooking, EscrowError, isAvailable } from './bookings.js';
import { CLAIM_DAYS, DAY_SECS, FEE_RATE, HORIZON_URL, loadKeys, OFFER_HOURS, PG_DIR, STAY_HOLD_DAYS } from './config.js';
import { openDb } from './db.js';
import { explorerContract, explorerTx, getBooking, ledgerTime } from './escrow.js';
import { usdcMxnRate } from './fx.js';
import { nightsBetween, POLICIES, quote } from './quote.js';
import { createOffer } from './offers.js';

const db = await openDb(PG_DIR);
const app = Fastify({ logger: false });
await app.register(cors);
const horizon = new Horizon.Server(HORIZON_URL);

app.setErrorHandler((err, _req, reply) => {
  const known = err instanceof BookingError || err instanceof EscrowError;
  if (!known) console.error(err);
  reply.status(known ? 400 : 500).send({ error: err.message });
});

async function usdcBalance(address: string): Promise<string | null> {
  try {
    const keys = loadKeys();
    const acc = await horizon.loadAccount(address);
    const line = acc.balances.find((b) => 'asset_code' in b && b.asset_code === keys.asset.code && 'asset_issuer' in b && b.asset_issuer === keys.asset.issuer);
    return line ? line.balance : null;
  } catch {
    return null;
  }
}

app.get('/api/config', async () => {
  const keys = loadKeys();
  const fx = await usdcMxnRate().catch(() => null);
  return {
    contractId: keys.contractId, contractExplorer: explorerContract(keys.contractId), asset: keys.asset,
    daySecs: DAY_SECS, feeRate: FEE_RATE, offerHours: OFFER_HOURS, stayHoldDays: STAY_HOLD_DAYS, claimDays: CLAIM_DAYS, fx, policies: POLICIES,
    arbiter: Keypair.fromSecret(keys.arbiter).publicKey(), platform: Keypair.fromSecret(keys.platform).publicKey(),
  };
});

app.get('/api/users', async () => {
  const users = (await db.query<{ id: number; name: string; role: string; stellar_address: string }>(`SELECT id, name, role, stellar_address, bio FROM users ORDER BY id`)).rows;
  return Promise.all(users.map(async (u) => ({ ...u, balance: await usdcBalance(u.stellar_address) })));
});

app.get('/api/listings', async () =>
  (await db.query(`SELECT l.*, u.name AS host_name FROM listings l JOIN users u ON u.id = l.host_id WHERE l.unlisted = FALSE ORDER BY l.id`)).rows);

app.get<{ Params: { hostId: string } }>('/api/hosts/:hostId/listings', async (req, reply) => {
  const hostId = Number(req.params.hostId);
  const host = (await db.query(`SELECT id FROM users WHERE id = $1 AND role = 'host'`, [hostId])).rows[0];
  if (!host) return reply.status(404).send({ error: 'Host not found' });
  return (await db.query(`SELECT * FROM listings WHERE host_id = $1 ORDER BY id`, [hostId])).rows;
});

app.get<{ Params: { slug: string } }>('/api/listings/:slug', async (req, reply) => {
  const l = (await db.query(`SELECT l.*, u.name AS host_name, u.bio AS host_bio, u.stellar_address AS host_address FROM listings l JOIN users u ON u.id = l.host_id WHERE l.slug = $1 AND l.unlisted = FALSE`, [req.params.slug])).rows[0];
  if (!l) return reply.status(404).send({ error: 'Listing not found' });
  const booked = (await db.query(`SELECT check_in::text, check_out::text FROM bookings WHERE listing_id = $1 AND status IN ('locked','disputed','stay_paid','released','resolved')
    UNION ALL SELECT check_in::text, check_out::text FROM rental_offers WHERE listing_id = $1 AND status = 'open' AND expires_at > NOW()
    ORDER BY check_in`, [(l as { id: number }).id])).rows;
  return { ...l, booked };
});

app.get<{ Querystring: { listingId: string; checkIn: string; checkOut: string } }>('/api/quote', async (req) => {
  const l = (await db.query<{ id: number; nightly_mxn: string; cleaning_mxn: string; deposit_mxn: string }>(`SELECT * FROM listings WHERE id = $1 AND unlisted = FALSE`, [Number(req.query.listingId)])).rows[0];
  if (!l) throw new BookingError('Listing not found');
  const nights = nightsBetween(req.query.checkIn, req.query.checkOut);
  if (!(nights >= 1 && nights <= 30)) throw new BookingError('A stay is 1 to 30 nights');
  const fx = await usdcMxnRate();
  return { ...quote(l, nights), available: await isAvailable(db, l.id, req.query.checkIn, req.query.checkOut), fx };
});

app.post<{ Body: { listingId: number; guestId: number; checkIn: string; checkOut: string; guests: number; offerCode?: string } }>('/api/bookings', async (req) =>
  db.transaction(async (tx) => {
    await tx.query(`SELECT id FROM listings WHERE id = $1 FOR UPDATE`, [req.body.listingId]);
    return createBooking(tx, req.body);
  }));

app.post<{ Body: { listingId: number; hostId: number; checkIn: string; checkOut: string; guests: number } }>('/api/offers', async (req) =>
  db.transaction((tx) => createOffer(tx, req.body, OFFER_HOURS, DAY_SECS)));

app.get<{ Params: { code: string } }>('/api/offers/:code', async (req, reply) => {
  if (!/^[A-Za-z0-9_-]{16,32}$/.test(req.params.code)) return reply.status(404).send({ error: 'Payment link not found' });
  const offer = (await db.query(`SELECT o.*, l.slug, l.title, l.area, l.cover, l.max_guests, l.amenities,
      u.name AS host_name, u.stellar_address AS host_address
    FROM rental_offers o JOIN listings l ON l.id = o.listing_id JOIN users u ON u.id = o.host_id WHERE o.code = $1`, [req.params.code])).rows[0] as Record<string, unknown> | undefined;
  if (!offer) return reply.status(404).send({ error: 'Payment link not found' });
  const expired = offer.status === 'open' && new Date(String(offer.expires_at)).getTime() <= Date.now();
  return { ...offer, status: expired ? 'expired' : offer.status, contractId: loadKeys().contractId };
});

app.get<{ Params: { hostId: string } }>('/api/hosts/:hostId/offers', async (req, reply) => {
  const hostId = Number(req.params.hostId);
  const host = (await db.query(`SELECT id FROM users WHERE id = $1 AND role = 'host'`, [hostId])).rows[0];
  if (!host) return reply.status(404).send({ error: 'Host not found' });
  const offers = (await db.query(`SELECT o.*, l.title, l.slug FROM rental_offers o JOIN listings l ON l.id = o.listing_id WHERE o.host_id = $1 ORDER BY o.created_at DESC`, [hostId])).rows as Array<Record<string, unknown>>;
  return offers.map((offer) => ({
    ...offer,
    status: offer.status === 'open' && new Date(String(offer.expires_at)).getTime() <= Date.now() ? 'expired' : offer.status,
  }));
});

app.post<{ Params: { code: string }; Body: { hostId: number } }>('/api/offers/:code/cancel', async (req, reply) => {
  const result = await db.query(`UPDATE rental_offers SET status = 'cancelled'
    WHERE code = $1 AND host_id = $2 AND status = 'open' AND expires_at > NOW() RETURNING code`, [req.params.code, req.body.hostId]);
  if (result.rows.length !== 1) return reply.status(404).send({ error: 'Open payment link not found for this host' });
  return { status: 'cancelled' };
});

app.post<{ Params: { id: string }; Body: { hostId: number; unlisted: boolean } }>('/api/listings/:id/unlisted', async (req, reply) => {
  const result = await db.query(`UPDATE listings SET unlisted = $1 WHERE id = $2 AND host_id = $3 RETURNING id`, [req.body.unlisted, Number(req.params.id), req.body.hostId]);
  if (result.rows.length !== 1) return reply.status(404).send({ error: 'Listing not found for this host' });
  return { unlisted: req.body.unlisted };
});

const BOOKING_SQL = `
  SELECT b.*, b.check_in::text AS check_in, b.check_out::text AS check_out, l.title, l.slug, l.area, l.cover,
         EXISTS (SELECT 1 FROM booking_events e WHERE e.booking_id = b.id AND e.kind = 'pay_stay') AS chain_stay_paid,
         g.name AS guest_name, g.stellar_address AS guest_address, h.name AS host_name, h.stellar_address AS host_address, h.id AS host_id
    FROM bookings b JOIN listings l ON l.id = b.listing_id JOIN users g ON g.id = b.guest_id JOIN users h ON h.id = l.host_id`;

app.get<{ Querystring: { guestId?: string; hostId?: string; status?: string } }>('/api/bookings', async (req) => {
  const where: string[] = [], args: unknown[] = [];
  if (req.query.guestId) { args.push(Number(req.query.guestId)); where.push(`b.guest_id = $${args.length}`); }
  if (req.query.hostId) { args.push(Number(req.query.hostId)); where.push(`h.id = $${args.length}`); }
  if (req.query.status) { args.push(req.query.status); where.push(`b.status = $${args.length}`); }
  return (await db.query(`${BOOKING_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY b.id DESC`, args)).rows;
});

app.get<{ Params: { id: string } }>('/api/bookings/:id', async (req, reply) => {
  const b = (await db.query<{ id: number; escrow_id: string }>(`${BOOKING_SQL} WHERE b.id = $1`, [Number(req.params.id)])).rows[0];
  if (!b) return reply.status(404).send({ error: 'Booking not found' });
  const keys = loadKeys();
  const [chain, now, events] = await Promise.all([
    getBooking(keys.contractId, Keypair.fromSecret(keys.platform).publicKey(), b.escrow_id).catch(() => null),
    ledgerTime().catch(() => Math.floor(Date.now() / 1000)),
    db.query<{ tx_hash: string | null }>(`SELECT * FROM booking_events WHERE booking_id = $1 ORDER BY id`, [b.id]),
  ]);
  return { ...b, chain, ledgerTime: now, events: events.rows.map((e) => ({ ...e, explorer: e.tx_hash ? explorerTx(e.tx_hash) : null })) };
});

for (const action of ['cancel', 'host_cancel', 'pay_stay', 'release', 'dispute', 'claim_damage', 'resolve', 'settle_default'] as const) {
  app.post<{ Params: { id: string }; Body: { by?: 'guest' | 'arbiter'; split?: { guest: string; host: string; platform: string } } }>(
    `/api/bookings/:id/${action.replace('_', '-')}`, async (req) => act(db, Number(req.params.id), action, req.body ?? {}));
}

const PORT = Number(process.env.PORT ?? 8797);
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`MicoPay Rentas API on http://127.0.0.1:${PORT} · demo day = ${DAY_SECS}s`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, async () => { await app.close(); await db.close(); process.exit(0); });
