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
    upgradeExisting: config.upgradeExisting === true,
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
  | { type: 'started'; parkName: string; date: string; targetNames: string[]; intervalSeconds: number; maxMinutesFromNow: number; upgradeExisting: boolean }
  | {
      type: 'booked';
      experienceName: string;
      startTime: string;
      date: string;
      guestCount: number;
      remaining: number;
      remainingNames: string[];
    }
  | {
      type: 'upgraded';
      experienceName: string;
      startTime: string;
      oldTime: string;
      date: string;
      guestCount: number;
    }
  | { type: 'ticket_issue'; reason: IneligibleReason; parkName: string; date: string }
  | { type: 'skip'; firstSkipReason: string; skippedCount: number; totalTargets: number }
  | { type: 'error'; message: string; parkName: string; date: string }
  | { type: 'stopped'; reason: string; parkName: string; date: string };

async function sendWebhook(url: string, event: WebhookEvent) {
  if (!url.trim()) return;
  let title: string;
  let description: string;
  let color: number;
  const fields: { name: string; value: string; inline?: boolean }[] = [];

  switch (event.type) {
    case 'started':
      title = '🟢 Auto Book Started';
      description = `Polling **${event.parkName}** on **${event.date}**`;
      color = 0x5865f2;
      fields.push(
        { name: 'Poll Interval', value: `${event.intervalSeconds}s`, inline: true },
        { name: 'Time Window', value: `≤ ${event.maxMinutesFromNow} min from now`, inline: true },
        { name: 'Upgrade Existing', value: event.upgradeExisting ? 'Yes' : 'No', inline: true },
        {
          name: `Rides Queued (${event.targetNames.length})`,
          value: event.targetNames.join('\n'),
          inline: false,
        }
      );
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
      if (event.remaining > 0) {
        fields.push({
          name: `Still to Book (${event.remaining})`,
          value: event.remainingNames.join('\n'),
          inline: false,
        });
      } else {
        fields.push({ name: 'Queue', value: '🎉 All targets booked!', inline: false });
      }
      break;
    case 'upgraded':
      title = '⬆️ Booking Upgraded!';
      description = `**${event.experienceName}**`;
      color = 0x57f287;
      fields.push(
        { name: 'New Time', value: formatTime(event.startTime), inline: true },
        { name: 'Previous', value: formatTime(event.oldTime), inline: true },
        { name: 'Date', value: event.date, inline: true },
        { name: 'Guests', value: String(event.guestCount), inline: true }
      );
      break;
    case 'ticket_issue':
      title = '⚠️ Ticket Issue — Stopped';
      description =
        event.reason === 'INVALID_PARK_ADMISSION'
          ? 'No valid park ticket found for any party member'
          : 'Park reservation required but not found';
      color = 0xfee75c;
      fields.push(
        { name: 'Park', value: event.parkName, inline: true },
        { name: 'Date', value: event.date, inline: true }
      );
      break;
    case 'skip':
      title = '⏭️ Targets Skipped';
      description = event.firstSkipReason;
      color = 0xffa500;
      fields.push(
        { name: 'Skipped', value: `${event.skippedCount} of ${event.totalTargets}`, inline: true }
      );
      break;
    case 'error':
      title = '❌ Error — Stopped';
      description = event.message;
      color = 0xed4245;
      fields.push(
        { name: 'Park', value: event.parkName, inline: true },
        { name: 'Date', value: event.date, inline: true }
      );
      break;
    case 'stopped':
      title = '⏹️ Auto Book Stopped';
      description = event.reason;
      color = 0x99aab5;
      fields.push(
        { name: 'Park', value: event.parkName, inline: true },
        { name: 'Date', value: event.date, inline: true }
      );
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
  const programmaticStopRef = useRef(false);
  const wasEnabledRef = useRef(config.enabled);
  const lastSkipWebhookMsgRef = useRef<string | null>(null);
  const consecutiveSameSkipCountRef = useRef(0);
  const dryRunBookedIdsRef = useRef<Set<string>>(new Set());
  const dryRunUpgradeTimesRef = useRef<Map<string, any>>(new Map());

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
      if (wasEnabledRef.current && !programmaticStopRef.current) {
        sendWebhook(config.webhookUrl, {
          type: 'stopped',
          reason: 'Manually stopped',
          parkName: park.name,
          date: bookingDate,
        }).catch(console.error);
      }
      programmaticStopRef.current = false;
      wasEnabledRef.current = false;
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

    wasEnabledRef.current = true;
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

    const safeSetStatus = (s: AutoBookStatus) => {
      if (!cancelled) setStatus(s);
    };

    const stopAutoBooker = (reason: string) => {
      if (cancelled) return;
      programmaticStopRef.current = true;
      saveConfig({ ...config, enabled: false });
      sendWebhook(config.webhookUrl, {
        type: 'stopped',
        reason,
        parkName: park.name,
        date: bookingDate,
      }).catch(console.error);
    };

    async function checkOnce() {
      if (checking.current || cancelled) return;
      checking.current = true;
      const lastChecked = DateTime.now().toString();
      safeSetStatus({ lastChecked, message: config.dryRun ? '[DRY RUN] Checking' : 'Checking', running: true });

      try {
        const targetIds = new Set(config.targetIds);
        const allExps = (await ll.experiences(park, bookingDate)).filter(
          isFlexExperience
        );

        // Send started webhook on first check of each session (has real ride names)
        const startFingerprint = `${park.id}:${bookingDate}:${config.targetIds.join(',')}`;
        if (startWebhookFingerprint.current !== startFingerprint) {
          startWebhookFingerprint.current = startFingerprint;
          lastSkipWebhookMsgRef.current = null;
          consecutiveSameSkipCountRef.current = 0;
          dryRunBookedIdsRef.current = new Set();
          dryRunUpgradeTimesRef.current = new Map();
          const targetNames = config.targetIds.map(
            id => allExps.find(e => e.id === id)?.name ?? `Ride (...${id.slice(-4)})`
          );
          sendWebhook(config.webhookUrl, {
            type: 'started',
            parkName: park.name,
            date: bookingDate,
            targetNames,
            intervalSeconds: config.intervalSeconds,
            maxMinutesFromNow: config.maxMinutesFromNow,
            upgradeExisting: config.upgradeExisting,
          }).catch(console.error);
        }
        const experiences = allExps
          .filter(exp => targetIds.has(exp.id))
          .filter(exp => !bookedIds.has(exp.id) && !(config.dryRun && dryRunBookedIdsRef.current.has(exp.id)))
          .sort(
            (a, b) =>
              (targetOrder.get(a.id) ?? Infinity) -
              (targetOrder.get(b.id) ?? Infinity)
          );

        const allBooked =
          config.targetIds.length > 0 &&
          config.targetIds.every(
            id => bookedIds.has(id) || (config.dryRun && dryRunBookedIdsRef.current.has(id))
          );

        if (experiences.length === 0) {
          if (!config.upgradeExisting) {
            if (allBooked) {
              stopAutoBooker('All configured targets have been booked');
            } else {
              safeSetStatus({
                lastChecked,
                message: `Targets not currently available (${config.targetIds.length} configured)`,
                running: true,
              });
            }
            return;
          }
          // upgradeExisting: fall through to upgrade pass
        }

        let firstSkipMsg: string | null = null;
        let lastSkipMsg: string | null = null;
        let skippedCount = 0;
        const isPermSkip = (m: string | null) =>
          !!m &&
          (m.includes('tier limit') || m.includes('no eligible guests'));

        for (const experience of experiences) {
          const name = experience.name;

          if (experience.flex.nextAvailableTime) {
            const nextTime = experience.flex.nextAvailableTime;
            if (
              !isCloseEnough(
                { date: bookingDate, time: nextTime },
                config.maxMinutesFromNow
              )
            ) {
              lastSkipMsg = `${name}: next slot ${formatTime(nextTime)} too far`;
              firstSkipMsg ??= lastSkipMsg;
              skippedCount++;
              continue;
            }
          }

          let guests: Guest[] = [];
          let ticketIssue: IneligibleReason | undefined;
          try {
            const guestData = await ll.guests(experience, bookingDate);
            guests = guestData.eligible.slice(0, ll.rules.maxPartySize);
            if (guests.length === 0) {
              const raw = guestData.ineligible[0]?.ineligibleReason;
              const reason: IneligibleReason | undefined =
                typeof raw === 'object' && raw !== null
                  ? (raw as any).ineligibleReason
                  : raw;
              if (
                reason === 'INVALID_PARK_ADMISSION' ||
                reason === 'PARK_RESERVATION_NEEDED'
              ) {
                ticketIssue = reason;
              } else {
                const tierMsg =
                  reason === 'TIER_LIMIT_REACHED'
                    ? `${name}: tier limit — cancel an existing tier-1 LL first`
                    : `${name}: no eligible guests (${reason ?? 'unknown'})`;
                lastSkipMsg = tierMsg;
                firstSkipMsg ??= lastSkipMsg;
                skippedCount++;
              }
            }
          } catch (error: any) {
            console.error(error);
            lastSkipMsg = `${name}: guests call failed (${error?.name ?? 'error'})`;
            firstSkipMsg ??= lastSkipMsg;
            skippedCount++;
            continue;
          }
          if (ticketIssue) {
            const msg =
              ticketIssue === 'INVALID_PARK_ADMISSION'
                ? 'No valid park ticket'
                : 'Park reservation needed';
            safeSetStatus({ lastChecked, message: msg, running: false });
            flash(msg, 'error');
            sendWebhook(config.webhookUrl, {
              type: 'ticket_issue',
              reason: ticketIssue,
              parkName: park.name,
              date: bookingDate,
            }).catch(console.error);
            stopAutoBooker(msg);
            return;
          }
          if (guests.length === 0) continue;
          if (!hasAvailableSlot(guests)) {
            lastSkipMsg = `${name}: party has 3 active LLs`;
            firstSkipMsg ??= lastSkipMsg;
            skippedCount++;
            continue;
          }

          try {
            const offer = await ll.offer(experience, guests, {
              date: bookingDate,
            });
            if (!isCloseEnough(offer.start, config.maxMinutesFromNow)) {
              lastSkipMsg = `${name}: offer at ${formatTime(offer.start.time)} too far`;
              firstSkipMsg ??= lastSkipMsg;
              skippedCount++;
              continue;
            }
            const booking = config.dryRun
              ? { experience: { id: experience.id, name: experience.name }, start: offer.start, guests }
              : await ll.book(offer);
            if (config.dryRun) {
              dryRunBookedIdsRef.current.add(booking.experience.id);
            } else {
              refreshPlans();
            }
            const justBookedIds = config.dryRun
              ? new Set([...bookedIds, ...dryRunBookedIdsRef.current])
              : new Set([...bookedIds, booking.experience.id]);
            const remaining = config.targetIds.filter(
              id => !justBookedIds.has(id)
            ).length;
            const remainingNames = config.targetIds
              .filter(id => !justBookedIds.has(id))
              .map(id => allExps.find(e => e.id === id)?.name ?? `Ride (...${id.slice(-4)})`);
            await sendWebhook(config.webhookUrl, {
              type: 'booked',
              experienceName: (config.dryRun ? '[DRY RUN] ' : '') + booking.experience.name,
              startTime: booking.start.time.toString(),
              date: booking.start.date,
              guestCount: booking.guests.length,
              remaining,
              remainingNames,
            });
            const bookedMsg = `Booked ${booking.experience.name} for ${formatTime(booking.start.time)}`;
            if (config.dryRun) {
              safeSetStatus({
                lastChecked,
                message: remaining > 0
                  ? `[DRY RUN] ${bookedMsg} — ${remaining} target${remaining === 1 ? '' : 's'} remaining`
                  : `[DRY RUN] ${bookedMsg}`,
                running: remaining > 0 || !!config.upgradeExisting,
              });
              if (remaining === 0 && !config.upgradeExisting) {
                stopAutoBooker('[DRY RUN] All targets simulated — no actual reservations were made');
              }
              return;
            }
            if (remaining === 0 && !config.upgradeExisting) {
              safeSetStatus({ lastChecked, message: bookedMsg, running: false });
              stopAutoBooker('All targets booked! Last: ' + bookedMsg);
            } else {
              safeSetStatus({
                lastChecked,
                message:
                  remaining > 0
                    ? `${bookedMsg} — ${remaining} target${remaining === 1 ? '' : 's'} remaining`
                    : bookedMsg,
                running: true,
              });
            }
            return;
          } catch (error: any) {
            if (
              error instanceof OfferError ||
              error?.response?.status === 410
            ) {
              lastSkipMsg = `${name}: offer unavailable`;
              firstSkipMsg ??= lastSkipMsg;
              skippedCount++;
              continue;
            }
            throw error;
          }
        }

        const finalMsg = firstSkipMsg
          ? `${skippedCount}/${experiences.length} skipped — ${firstSkipMsg}`
          : allBooked
            ? 'All targets booked'
            : 'No targets currently available';
        safeSetStatus({ lastChecked, message: finalMsg, running: true });
        if (lastSkipMsg && firstSkipMsg !== lastSkipWebhookMsgRef.current) {
          lastSkipWebhookMsgRef.current = firstSkipMsg;
          consecutiveSameSkipCountRef.current = isPermSkip(firstSkipMsg) ? 1 : 0;
          sendWebhook(config.webhookUrl, {
            type: 'skip',
            firstSkipReason: firstSkipMsg ?? 'Unknown reason',
            skippedCount,
            totalTargets: experiences.length,
          }).catch(console.error);
        } else if (firstSkipMsg && isPermSkip(firstSkipMsg)) {
          consecutiveSameSkipCountRef.current++;
          if (consecutiveSameSkipCountRef.current >= 5) {
            stopAutoBooker(
              `Auto-stopped: ${firstSkipMsg} (5 consecutive cycles)`
            );
            return;
          }
        } else {
          consecutiveSameSkipCountRef.current = 0;
        }

        // Upgrade pass: check booked targets for earlier available slots
        if (config.upgradeExisting) {
          const bookedTargets = currentBookings.filter(b =>
            targetIds.has(b.experience.id)
          );
          for (const existingBooking of bookedTargets) {
            if (cancelled) break;
            const exp = allExps.find(
              e => e.id === existingBooking.experience.id
            );
            if (!exp) continue;
            let upGuests: Guest[] = [];
            try {
              const gd = await ll.guests(exp, bookingDate);
              upGuests = gd.eligible.slice(0, ll.rules.maxPartySize);
            } catch {
              continue;
            }
            if (upGuests.length === 0) continue;
            try {
              const offer = await ll.offer(exp, upGuests, {
                booking: existingBooking,
              });
              const effectiveBookingTime = config.dryRun && dryRunUpgradeTimesRef.current.has(exp.id)
                ? dryRunUpgradeTimesRef.current.get(exp.id)
                : existingBooking.start.time;
              if (
                +offer.start.time < +effectiveBookingTime &&
                isCloseEnough(offer.start, config.maxMinutesFromNow)
              ) {
                const upgraded = config.dryRun
                  ? { experience: { id: exp.id, name: exp.name }, start: offer.start, guests: upGuests }
                  : await ll.book(offer);
                if (config.dryRun) {
                  dryRunUpgradeTimesRef.current.set(exp.id, offer.start.time);
                } else {
                  refreshPlans();
                }
                await sendWebhook(config.webhookUrl, {
                  type: 'upgraded',
                  experienceName: (config.dryRun ? '[DRY RUN] ' : '') + upgraded.experience.name,
                  startTime: upgraded.start.time.toString(),
                  oldTime: effectiveBookingTime.toString(),
                  date: upgraded.start.date,
                  guestCount: upgraded.guests.length,
                });
                safeSetStatus({
                  lastChecked,
                  message: `${config.dryRun ? '[DRY RUN] ' : ''}Upgraded ${upgraded.experience.name} to ${
                    formatTime(upgraded.start.time)
                  } (was ${formatTime(effectiveBookingTime)})`,
                  running: true,
                });
                break;
              }
            } catch {
              continue;
            }
          }
        }
      } catch (error: any) {
        console.error(error);
        if (error?.name === 'RateLimitExceeded') {
          safeSetStatus({
            lastChecked,
            message: 'Rate limited — will retry',
            running: true,
          });
          return;
        }
        const errMsg = error?.message ?? error?.name ?? 'Auto-book check failed';
        safeSetStatus({
          lastChecked,
          message: error?.name ?? 'Auto-book check failed',
          running: false,
        });
        sendWebhook(config.webhookUrl, {
          type: 'error',
          message: errMsg,
          parkName: park.name,
          date: bookingDate,
        }).catch(console.error);
        stopAutoBooker(`Error: ${errMsg}`);      } finally {
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
