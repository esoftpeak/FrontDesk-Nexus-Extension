import type { ReactNode } from 'react'
import type { EzeeGuestDisplay, ReservationSnapshot, SynxisGuestDisplay } from '../shared/pms-types'
import { formatHotelDateTime } from '../lib/hotel-dates'

type Props = {
  res: ReservationSnapshot
  guest: SynxisGuestDisplay | null
  ezee: EzeeGuestDisplay | null
  pmsLabel: string
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  if (value == null || value === '' || value === '—') return null
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  )
}

/** Full PMS guest / stay context — shown on every workspace tab when a reservation is loaded. */
export function GuestStaySummary({ res, guest, ezee, pmsLabel }: Props) {
  const isEzee = res.pms === 'ezee'
  const conf = res.confirmationNumber ?? ezee?.reservationNumber ?? guest?.pmsConfirmationCode ?? '—'

  const checkIn =
    formatHotelDateTime(res.checkInDate, 14) !== '—'
      ? formatHotelDateTime(res.checkInDate, 14)
      : (ezee?.staySummary?.split('→')[0]?.trim() ?? null)
  const checkOut =
    formatHotelDateTime(res.checkOutDate, 12) !== '—'
      ? formatHotelDateTime(res.checkOutDate, 12)
      : (ezee?.staySummary?.split('→')[1]?.trim() ?? null)

  return (
    <section className="fdn-stay-summary" aria-label="Loaded reservation">
      <div className="fdn-stay-summary__head">
        <span className="fdn-stay-summary__pms">{pmsLabel}</span>
        <span className="fdn-stay-summary__conf">#{conf}</span>
        {res.restricted ? <span className="fdn-tag fdn-tag--warn">Restricted</span> : null}
      </div>
      <dl className="fdn-stay-summary__grid">
        {isEzee && ezee ? (
          <>
            <Row label="Guest" value={ezee.nameLine ?? res.guestName} />
            <Row label="Status" value={ezee.status} />
            <Row label="Room" value={ezee.roomNumber ?? res.roomNumber} />
            <Row label="Address" value={ezee.addressLine ?? res.addressRaw} />
            <Row label="Arrival" value={checkIn} />
            <Row label="Departure" value={checkOut} />
            <Row label="Email" value={ezee.email ?? res.email} />
            <Row label="Phone" value={ezee.phone ?? res.phone} />
            <Row label="Total" value={ezee.total ?? res.reservationTotal} />
            <Row label="Paid" value={ezee.paid ?? res.amountPaid} />
            <Row label="Balance" value={ezee.balance ?? res.dueAmount} />
          </>
        ) : guest ? (
          <>
            <Row label="Guest" value={guest.nameLine} />
            <Row label="Loyalty" value={guest.membershipId} />
            <Row label="Room" value={res.roomNumber} />
            <Row
              label="Address"
              value={
                guest.addresses.length === 0
                  ? res.addressRaw
                  : guest.addresses.map((a, i) => (
                      <div key={i}>
                        {[a.city, a.country, a.postalCode].filter(Boolean).join(', ')}
                        {a.type ? ` (${a.type})` : ''}
                      </div>
                    ))
              }
            />
            <Row label="Stay" value={guest.staySummary ?? res.stayDatesRaw} />
            <Row label="Arrival" value={checkIn} />
            <Row label="Departure" value={checkOut} />
            <Row label="Email" value={guest.email ?? res.email} />
            <Row label="Phone" value={guest.phone ?? res.phone} />
            <Row label="Total" value={res.reservationTotal} />
            <Row label="Paid" value={res.amountPaid} />
            <Row label="Balance" value={res.dueAmount} />
          </>
        ) : (
          <>
            <Row label="Guest" value={res.guestName} />
            <Row label="Room" value={res.roomNumber} />
            <Row label="Address" value={res.addressRaw} />
            <Row label="Stay" value={res.stayDatesRaw} />
            <Row label="Arrival" value={checkIn} />
            <Row label="Departure" value={checkOut} />
            <Row label="Email" value={res.email} />
            <Row label="Phone" value={res.phone} />
            <Row label="Total" value={res.reservationTotal} />
            <Row label="Paid" value={res.amountPaid} />
            <Row label="Balance" value={res.dueAmount} />
          </>
        )}
      </dl>
    </section>
  )
}
