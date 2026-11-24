import Big from 'big.js';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Cover, ErrorBox, Panel, Row, usePersona } from '../comun';
import { day, mxn, short, when } from '../format';
import { Button, Label } from '../ui';
import { useData } from '../useData';

export default function OfferPage() {
  const { code = '' } = useParams();
  const { data: offer, error, reload } = useData(() => api.offer(code), [code]);
  const { persona, config } = usePersona();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(reload, 5_000);
    return () => clearInterval(timer);
  }, [reload]);

  if (error) return <ErrorBox msg={error} />;
  if (!offer) return null;

  const guest = persona?.kind === 'guest' ? persona.user : null;
  const ownLink = guest?.stellar_address === offer.host_address;
  const policy = config?.policies[offer.policy];
  const canBook = offer.status === 'open' && !!guest && !ownLink;

  async function book() {
    if (!guest || !canBook) return;
    setBusy(true); setBookingError(null);
    try {
      const booking = await api.book({
        listingId: offer.listing_id,
        guestId: guest.id,
        checkIn: offer.check_in,
        checkOut: offer.check_out,
        guests: offer.guests,
        offerCode: offer.code,
      });
      navigate(`/bookings/${booking.id}`);
    } catch (e) {
      setBookingError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-3xl gap-5">
      <div className="overflow-hidden rounded-sm border-2 border-tinta bg-papel shadow-solida">
        <Cover n={offer.cover} title={offer.title} className="aspect-[16/9] border-0 border-b-2" />
        <div className="space-y-2 p-4">
          <Label>{offer.area}</Label>
          <h1 className="font-display text-[28px] font-extrabold leading-tight">{offer.title}</h1>
          <p>Host <b>{offer.host_name}</b></p>
          <p className="break-all font-mono text-[13px] text-gris">Stellar: {offer.host_address}</p>
        </div>
      </div>

      <ErrorBox msg={bookingError} />
      {offer.status !== 'open' && (
        <div role="status" className="rounded-sm border-2 border-tinta bg-aviso px-4 py-3 font-bold shadow-solida">
          This payment link is {offer.status}. It cannot be used to pay.
        </div>
      )}
      {ownLink && offer.status === 'open' && <ErrorBox msg="A host cannot pay their own link. Switch to a guest persona." />}

      <Panel title="Stay and price">
        <div className="space-y-1">
          <Row k="Dates" v={<>{day(offer.check_in)} → {day(offer.check_out)}</>} />
          <Row k="Guests" v={offer.guests} />
          <Row k={`${mxn(offer.nightly_mxn)} × ${offer.nights} nights`} v={mxn(new Big(offer.nightly_mxn).times(offer.nights).toFixed(2))} />
          <Row k="Cleaning" v={mxn(offer.cleaning_mxn)} />
          <Row k="MicoPay fee" v={mxn(offer.fee_mxn)} />
          <Row k="Refundable deposit" v={mxn(offer.deposit_mxn)} />
          <Row strong k="Total into escrow" v={mxn(offer.total_mxn)} />
        </div>
      </Panel>

      <Panel title={`Cancellation policy · ${policy?.label ?? offer.policy}`}>
        <ul className="space-y-2 text-[14px]">
          {policy?.tiers.map((tier) => (
            <li key={tier.days}>Cancel at least <b>{tier.days} day{tier.days === 1 ? '' : 's'}</b> before check-in: <b>{tier.refundPct}%</b> of the stay and fee back.</li>
          ))}
          <li>Later cancellations do not refund the stay. The damage deposit comes back if there is no damage claim. If the host cancels, you receive everything back.</li>
        </ul>
      </Panel>

      <Panel title="Payment timeline">
        <ul className="space-y-2 text-[14px]">
          <li>The host is paid for the stay {config?.stayHoldDays ?? 1} day{(config?.stayHoldDays ?? 1) === 1 ? '' : 's'} after check-in.</li>
          <li>The damage deposit stays in escrow until claims close, {config?.claimDays ?? 2} day{(config?.claimDays ?? 2) === 1 ? '' : 's'} after check-out, or until you release it.</li>
          <li>Escrow contract: <span className="break-all font-mono">{offer.contractId}</span></li>
          <li>Payment link expires: <b>{when(offer.expires_at)}</b></li>
        </ul>
      </Panel>

      {offer.status === 'open' && (
        <div className="space-y-2">
          {canBook ? (
            <>
              <Button block disabled={busy} onClick={book}>{busy ? 'Locking in escrow on Stellar…' : 'Book and pay into escrow'}</Button>
              <p className="text-center text-[12px] text-gris">The quoted MXN amount is fixed. USDC converts at the exchange rate when you pay.</p>
            </>
          ) : !ownLink && <p className="text-center text-[14px] text-gris">Switch to a guest persona to book this stay.</p>}
        </div>
      )}
      {offer.booking_id && offer.status === 'used' && (
        <p className="text-center text-[13px] text-gris">Booking {short(String(offer.booking_id))} was created from this link.</p>
      )}
    </div>
  );
}
