import { use, useCallback, useEffect, useRef, useState } from 'react';

import { isLLMP } from '@/api/itinerary';
import { FlexExperience, Guest, IneligibleReason, OfferError, OfferExperience } from '@/api/ll';
import useFlash from '@/hooks/useFlash';
import AutoBookContext, {
  AUTO_BOOK_KEY,
  AutoBookConfig,
  AutoBookStatus,
  DEFAULT_AUTO_BOOK_CONFIG,
} from '@/contexts/AutoBookContext';
import BookingDateContext from '@/contexts/BookingDateContext';
import ClientsContext from '@/contexts/ClientsContext';
import ParkContext from '@/contexts/ParkContext';
import PlansContext from '@/contexts/PlansContext';
import { DateTime, formatTime, parkDate } from '@/datetime';
import kvdb from '@/kvdb';

function loadConfig(): AutoBookConfig {
  const config = kvdb.get<Partial<AutoBookConfig>>(AUTO_BOOK_KEY) ?? {};
  return {
    ...DEFAULT_AUTO_BOOK_CONFIG,
    ...config,
    targetIds: Array.isArray(config.targetIds) ? config.targetIds : [],
    intervalSeconds: Math.max(1, Math.min(30, config.intervalSeconds ?? 3)),
    maxMinutesFromNow: Math.max(1, config.maxMinutesFromNow ?? 120),
    webhookUrl: typeof config.webhookUrl === 'string' ? config.webhookUrl : '',
  };
}

function isFlexExperience(exp: OfferExperience): exp is FlexExperience {
  return !!exp.flex;
}

function isCloseEnough(
  time: { date: string; time: { valueOf(): number } },
  maxMinutes: number
) {
  if (time.date !== parkDate()) return true;
  const secondsFromNow = +time.time - +DateTime.now().time;
  return secondsFromNow >= 0 && secondsFromNow <= maxMinutes * 60;
}

type WebhookEvent =
  | { type: 'started'; parkName: string; date: string; targetCount: number }
  | {
      type: 'booked';
      experienceName: string;
      startTime: string;
      date: string;
      guestCount: number;
    }
  | { type: 'ticket_issue'; reason: IneligibleReason }
  | { type: 'error'; message: string };

async function sendWebhook(url: string, event: WebhookEvent) {
  if (!url.trim()) return;
  let title: string;
  let description: string;
  let color: number;
  const fields: { name: string; value: string; inline?: boolean }[] = [];

  switch (event.type) {
    case 'started':
      title = '🟢 Auto Book Started';
      description = `Polling **${event.parkName}** on **${event.date}** — ${event.targetCount} target${event.targetCount === 1 ? '' : 's'}`;
      color = 0x5865f2;
      break;
    case 'booked':
      title = '✅ Booked!';
      description = `**${event.experienceName}**`;
      color = 0x57f287;
      fields.push(
        { name: 'Time', value: formatTime(event.startTime), inline: true },
        { name: 'Date', value: event.date, inline: true },
        { name: 'Guests', value: String(event.guestCount), inline: true }
      );
      break;
    case 'ticket_issue':
      title = '⚠️ Ticket Issue — Auto Book Stopped';
      description =
        event.reason === 'INVALID_PARK_ADMISSION'
          ? 'No valid park ticket found for any party member'
          : 'Park reservation required but not found';
      color = 0xfee75c;
      break;
    case 'error':
      title = '❌ Auto Book Error — Polling Stopped';
      description = event.message;
      color = 0xed4245;
      break;
  }

  await fetch(url.trim(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [
        {
          title,
          description,
          color,
          ...(fields.length > 0 && { fields }),
          timestamp: new Date().toISOString(),
          footer: { text: 'bg1 Auto Book' },
        },
      ],
    }),
  });
}

export default function AutoBookProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { ll } = use(ClientsContext);
  const { park } = use(ParkContext);
  const { bookingDate } = use(BookingDateContext);
  const { plans, refreshPlans } = use(PlansContext);
  const [flashElem, flash] = useFlash();
  const [config, setConfig] = useState(loadConfig);
  const [status, setStatus] = useState<AutoBookStatus>({
    message: config.enabled ? 'Starting' : 'Off',
    running: false,
  });
  const checking = useRef(false);
  const startWebhookFingerprint = useRef<string | null>(null);

  const saveConfig = useCallback((newConfig: AutoBookConfig) => {
    newConfig = {
      ...newConfig,
      intervalSeconds: Math.max(1, Math.min(30, newConfig.intervalSeconds)),
      maxMinutesFromNow: Math.max(1, newConfig.maxMinutesFromNow),
    };
    kvdb.set<AutoBookConfig>(AUTO_BOOK_KEY, newConfig);
    setConfig(newConfig);
  }, []);

  useEffect(() => {
    if (!config.enabled) {
      setStatus(status => ({
        ...status,
        message: status.message.startsWith('Booked ') ? status.message : 'Off',
        running: false,
      }));
      return;
    }
    if (config.targetIds.length === 0) {
      setStatus({
        message: 'Choose at least one target attraction',
        running: false,
      });
      return;
    }

    const startFingerprint = `${park.id}:${bookingDate}:${config.targetIds.join(',')}`;
    if (startWebhookFingerprint.current !== startFingerprint) {
      startWebhookFingerprint.current = startFingerprint;
      sendWebhook(config.webhookUrl, {
        type: 'started',
        parkName: park.name,
        date: bookingDate,
        targetCount: config.targetIds.length,
      }).catch(console.error);
    }

    let cancelled = false;
    const currentBookings = plans
      .filter(isLLMP)
      .filter(
        b =>
          b.start.date === bookingDate &&
          !!b.cancellable &&
          +b.end.time > +DateTime.now().time
      );
    const bookedIds = new Set(currentBookings.map(b => b.experience.id));
    const bookingCountByGuestId = new Map<string, number>();
    for (const booking of currentBookings) {
      for (const guest of booking.guests) {
        bookingCountByGuestId.set(
          guest.id,
          (bookingCountByGuestId.get(guest.id) ?? 0) + 1
        );
      }
    }
    const hasAvailableSlot = (guests: Guest[]) =>
      guests.every(guest => (bookingCountByGuestId.get(guest.id) ?? 0) < 3);
    const targetOrder = new Map(
      config.targetIds.map((id, index) => [id, index])
    );

    async function checkOnce() {
      if (checking.current || cancelled) return;
      checking.current = true;
      const lastChecked = DateTime.now().toString();
      setStatus({ lastChecked, message: 'Checking', running: true });

      try {
        const targetIds = new Set(config.targetIds);
        const experiences = (await ll.experiences(park, bookingDate))
          .filter(isFlexExperience)
          .filter(exp => targetIds.has(exp.id))
          .filter(exp => !bookedIds.has(exp.id))
          .sort(
            (a, b) =>
              (targetOrder.get(a.id) ?? Infinity) -
              (targetOrder.get(b.id) ?? Infinity)
          );

        for (const experience of experiences) {
          if (
            experience.flex.nextAvailableTime &&
            !isCloseEnough(
              { date: bookingDate, time: experience.flex.nextAvailableTime },
              config.maxMinutesFromNow
            )
          ) {
            continue;
          }

          let guests: Guest[] = [];
          let ticketIssue: IneligibleReason | undefined;
          try {
            const guestData = await ll.guests(experience, bookingDate);
            guests = guestData.eligible.slice(0, ll.rules.maxPartySize);
            if (guests.length === 0) {
              const reason = guestData.ineligible[0]?.ineligibleReason;
              if (
                reason === 'INVALID_PARK_ADMISSION' ||
                reason === 'PARK_RESERVATION_NEEDED'
              ) {
                ticketIssue = reason;
              }
            }
          } catch (error) {
            console.error(error);
            continue;
          }
          if (ticketIssue) {
            const msg =
              ticketIssue === 'INVALID_PARK_ADMISSION'
                ? 'No valid park ticket'
                : 'Park reservation needed';
            setStatus({ lastChecked, message: msg, running: false });
            flash(msg, 'error');
            sendWebhook(config.webhookUrl, {
              type: 'ticket_issue',
              reason: ticketIssue,
            }).catch(console.error);
            return;
          }
          if (guests.length === 0) continue;
          if (!hasAvailableSlot(guests)) {
            setStatus({
              lastChecked,
              message: 'Party already has 3 active LLs',
              running: true,
            });
            continue;
          }

          try {
            const offer = await ll.offer(experience, guests, {
              date: bookingDate,
            });
            if (!isCloseEnough(offer.start, config.maxMinutesFromNow)) {
              continue;
            }
            const booking = await ll.book(offer);
            refreshPlans();
            await sendWebhook(config.webhookUrl, {
              type: 'booked',
              experienceName: booking.experience.name,
              startTime: booking.start.time.toString(),
              date: booking.start.date,
              guestCount: booking.guests.length,
            });
            saveConfig({ ...config, enabled: false });
            setStatus({
              lastChecked,
              message: `Booked ${booking.experience.name} for ${formatTime(
                booking.start.time
              )}`,
              running: false,
            });
            return;
          } catch (error: any) {
            if (
              error instanceof OfferError ||
              error?.response?.status === 410
            ) {
              continue;
            }
            throw error;
          }
        }

        setStatus({
          lastChecked,
          message: experiences.length
            ? 'No matching slot yet'
            : 'No targets available',
          running: true,
        });
      } catch (error: any) {
        console.error(error);
        const errMsg = error?.message ?? error?.name ?? 'Auto-book check failed';
        setStatus({
          lastChecked,
          message: error?.name ?? 'Auto-book check failed',
          running: false,
        });
        sendWebhook(config.webhookUrl, {
          type: 'error',
          message: errMsg,
        }).catch(console.error);
      } finally {
        checking.current = false;
      }
    }

    checkOnce();
    const intervalId = setInterval(checkOnce, config.intervalSeconds * 1000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [bookingDate, config, ll, park, plans, refreshPlans, saveConfig]);

  return (
    <AutoBookContext value={{ config, saveConfig, status }}>
      {children}
      {flashElem}
    </AutoBookContext>
  );
}
