import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isAvailable } from '../src/bookings.js';
import { openDb, type Db } from '../src/db.js';
import { createOffer } from '../src/offers.js';

describe('payment offers', () => {
  let db: Db | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    if (db) await db.close();
    if (dir) await rm(dir, { recursive: true, force: true });
    db = undefined;
    dir = undefined;
  });

  it('creates an unguessable URL-safe code and holds dates only while open and unexpired', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rentas-offers-'));
    db = await openDb(dir);
    const hostId = (await db.query<{ id: number }>(
      `INSERT INTO users (name, role, stellar_address) VALUES ('Host', 'host', 'GHOST') RETURNING id`,
    )).rows[0]!.id;
    const listingId = (await db.query<{ id: number }>(
      `INSERT INTO listings (host_id, slug, title, area, summary, description, nightly_mxn, cleaning_mxn, deposit_mxn,
         max_guests, bedrooms, policy, amenities)
       VALUES ($1,'offer-test','Offer test','Centro','','','1000','100','500',4,2,'flexible','[]') RETURNING id`,
      [hostId],
    )).rows[0]!.id;
    const checkIn = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const checkOut = new Date(Date.now() + 11 * 86_400_000).toISOString().slice(0, 10);
    const input = { listingId, hostId, checkIn, checkOut, guests: 2 };

    const created = await db.transaction((tx) => createOffer(tx, input, 24, 60));
    expect(created.code).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(await isAvailable(db, listingId, checkIn, checkOut)).toBe(false);

    await db.query(`UPDATE rental_offers SET expires_at = NOW() - INTERVAL '1 second' WHERE code = $1`, [created.code]);
    expect(await isAvailable(db, listingId, checkIn, checkOut)).toBe(true);
    const next = await db.transaction((tx) => createOffer(tx, input, 24, 60));
    expect(next.code).not.toBe(created.code);
  });
});
