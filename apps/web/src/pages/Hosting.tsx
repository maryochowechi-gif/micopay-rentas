import Big from 'big.js';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox, usePersona } from '../comun';
import { isoDay, mxn, usdc, day, when } from '../format';
import { Button, MoneyBlock } from '../ui';
import { useData } from '../useData';
import { BookingList } from './Trips';

export default function Hosting() {
  const { persona } = usePersona();
  const host = persona?.kind === 'host' ? persona.user : null;
  const { data, error } = useData(() => (host ? api.bookings({ hostId: host.id }) : Promise.resolve(null)), [host?.id]);
  const listings = useData(() => (host ? api.hostListings(host.id) : Promise.resolve([])), [host?.id]);
  const offers = useData(() => (host ? api.offers(host.id) : Promise.resolve([])), [host?.id]);
  const [listingId, setListingId] = useState<number>(0);
  const [checkIn, setCheckIn] = useState(isoDay(3));
  const [checkOut, setCheckOut] = useState(isoDay(5));
  const [guests, setGuests] = useState(2);
  const [busy, setBusy] = useState(false);
  const [offerError, setOfferError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newCode, setNewCode] = useState<string | null>(null);
  const inEscrow = (data ?? []).filter((b) => b.status === 'locked' || b.status === 'stay_paid' || b.status === 'disputed')
    .reduce((a, b) => a.plus(b.chain_stay_paid ? b.deposit_mxn : b.subtotal_mxn), new Big(0));
  const paid = (data ?? []).filter((b) => b.chain_stay_paid || b.status === 'stay_paid' || b.status === 'released')
    .reduce((a, b) => a.plus(b.subtotal_mxn), new Big(0));
  useEffect(() => {
    setListingId(listings.data?.[0]?.id ?? 0);
  }, [host?.id, listings.data]);
  if (!host) return <div className="text-gris">Switch to a host (top right).</div>;
  const linkFor = (code: string) => `${window.location.origin}/r/${code}`;

  async function createLink() {
    if (!host || !listingId) return;
    setBusy(true); setOfferError(null); setNotice(null); setNewCode(null);
    try {
      const result = await api.createOffer({ listingId, hostId: host.id, checkIn, checkOut, guests });
      setNewCode(result.code);
      setNotice(`Payment link expires ${when(result.expires_at)}.`);
      offers.reload();
      listings.reload();
    } catch (e) {
      setOfferError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancelLink(code: string) {
    setOfferError(null); setNotice(null);
    try {
      await api.cancelOffer(code, host!.id);
      offers.reload();
    } catch (e) {
      setOfferError((e as Error).message);
    }
  }

  async function toggleUnlisted(id: number, unlisted: boolean) {
    setOfferError(null);
    try {
      await api.setUnlisted(id, host!.id, !unlisted);
      listings.reload();
    } catch (e) {
      setOfferError((e as Error).message);
    }
  }

  async function copyLink(code: string) {
    try {
      await navigator.clipboard.writeText(linkFor(code));
      setNotice('Link copied.');
    } catch {
      setOfferError('Could not copy the link. Copy its address from the link below.');
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="font-display text-[32px] font-extrabold">Hosting · {host.name}</h1>
      <div className="grid gap-4 sm:grid-cols-3">
        <MoneyBlock etiqueta="Balance in MicoPay" cifra={host.balance ? usdc(host.balance) : '—'} pie="Withdraw to SPEI or cash in the MicoPay app" />
        <MoneyBlock tipo="cobro" etiqueta="Waiting in escrow" cifra={mxn(inEscrow.toFixed(2))} pie="Stay paid after the hold; deposit stays through claims" />
        <MoneyBlock etiqueta="Paid out (stays)" cifra={mxn(paid.toFixed(2))} pie="Full price: the fee is paid by the guest" />
      </div>
      <ErrorBox msg={error} />
      <ErrorBox msg={listings.error ?? offers.error ?? offerError} />
      {notice && <p role="status" className="rounded-sm border-2 border-tinta bg-verde-suave px-3 py-2 text-[14px] font-semibold">{notice}</p>}
      <section className="space-y-4 rounded-sm border-2 border-tinta bg-papel p-4 shadow-solida">
        <div>
          <h2 className="font-display text-[22px] font-extrabold">Create a payment link</h2>
          <p className="text-[14px] text-gris">Share one stay's dates and current listing price with a guest.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-[13px] font-bold text-gris sm:col-span-2">Listing
            <select value={listingId || ''} onChange={(e) => setListingId(Number(e.target.value))} className="mt-1 min-h-12 w-full rounded-sm border-2 border-tinta bg-fondo px-3 text-[16px] text-tinta">
              {listings.data?.map((l) => <option key={l.id} value={l.id}>{l.title}{l.unlisted ? ' · unlisted' : ''}</option>)}
            </select>
          </label>
          <label className="text-[13px] font-bold text-gris">Check-in
            <input type="date" min={isoDay(1)} value={checkIn} onChange={(e) => setCheckIn(e.target.value)} className="mt-1 min-h-12 w-full rounded-sm border-2 border-tinta bg-fondo px-2 text-[16px] text-tinta" />
          </label>
          <label className="text-[13px] font-bold text-gris">Check-out
            <input type="date" min={checkIn} value={checkOut} onChange={(e) => setCheckOut(e.target.value)} className="mt-1 min-h-12 w-full rounded-sm border-2 border-tinta bg-fondo px-2 text-[16px] text-tinta" />
          </label>
          <label className="text-[13px] font-bold text-gris sm:col-span-2">Guests
            <input type="number" min={1} max={listings.data?.find((l) => l.id === listingId)?.max_guests ?? 1} value={guests} onChange={(e) => setGuests(Number(e.target.value))} className="mt-1 min-h-12 w-full rounded-sm border-2 border-tinta bg-fondo px-3 text-[16px] text-tinta" />
          </label>
        </div>
        <Button block disabled={busy || !listingId || !checkIn || !checkOut || guests < 1} onClick={createLink}>
          {busy ? 'Creating payment link…' : 'Create payment link'}
        </Button>
        {newCode && (
          <div className="space-y-3 rounded-sm border-2 border-tinta bg-fondo p-3">
            <p className="font-bold">Share this link</p>
            <a className="break-all text-[14px] underline focus-visible:outline-2 focus-visible:outline-offset-2" href={linkFor(newCode)}>{linkFor(newCode)}</a>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button variant="ghost" onClick={() => copyLink(newCode)}>Copy</Button>
              <a className="inline-flex min-h-12 items-center justify-center rounded-sm border-2 border-tinta bg-naranja px-4 py-3 text-center font-bold text-papel shadow-solida focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tinta"
                href={`https://wa.me/?text=${encodeURIComponent(`Book ${linkFor(newCode)}`)}`} target="_blank" rel="noreferrer">Send by WhatsApp</a>
            </div>
          </div>
        )}
      </section>
      <section className="space-y-3 rounded-sm border-2 border-tinta bg-papel p-4 shadow-solida">
        <h2 className="font-display text-[22px] font-extrabold">My payment links</h2>
        {!offers.data?.length && <p className="text-gris">No payment links yet.</p>}
        {offers.data?.map((o) => (
          <article key={o.code} className="space-y-2 border-t-2 border-tinta pt-3 first:border-0 first:pt-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link className="font-bold underline" to={`/r/${o.code}`}>{o.title} · {day(o.check_in)} → {day(o.check_out)}</Link>
              <span className="font-bold capitalize">Status: {o.status}</span>
            </div>
            <p className="text-[13px] text-gris">{o.guests} guests · {mxn(o.total_mxn)} · expires {when(o.expires_at)}</p>
            <div className="flex flex-wrap gap-2">
              {o.status === 'open' && <Button variant="ghost" onClick={() => copyLink(o.code)}>Copy</Button>}
              {o.status === 'open' && <a className="inline-flex min-h-12 items-center justify-center rounded-sm border-2 border-tinta bg-naranja px-4 py-3 font-bold text-papel shadow-solida focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tinta"
                href={`https://wa.me/?text=${encodeURIComponent(`Book ${linkFor(o.code)}`)}`} target="_blank" rel="noreferrer">Send by WhatsApp</a>}
              {o.status === 'open' && <Button variant="peligro" onClick={() => cancelLink(o.code)}>Cancel link</Button>}
            </div>
          </article>
        ))}
      </section>
      <section className="space-y-3 rounded-sm border-2 border-tinta bg-papel p-4 shadow-solida">
        <h2 className="font-display text-[22px] font-extrabold">Listing visibility</h2>
        {listings.data?.map((l) => (
          <div key={l.id} className="flex flex-wrap items-center justify-between gap-3 border-t-2 border-tinta pt-3 first:border-0 first:pt-0">
            <div><p className="font-bold">{l.title}</p><p className="text-[13px] text-gris">Home visibility: {l.unlisted ? 'Unlisted' : 'Listed'}</p></div>
            <Button variant="ghost" onClick={() => toggleUnlisted(l.id, l.unlisted)}>{l.unlisted ? 'List on Home' : 'Mark unlisted'}</Button>
          </div>
        ))}
      </section>
      <BookingList items={data} who="host" empty="No bookings yet." />
    </div>
  );
}
