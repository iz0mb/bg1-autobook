import { use, useCallback, useEffect, useRef, useState } from 'react';

import { LLMP, isLLMP } from '@/api/itinerary';
import {
  FlexExperience,
  Guest,
  IneligibleReason,
  OfferError,
  OfferExperience,
} from '@/api/ll';
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
import ResortContext from '@/contexts/ResortContext';
import {
  DateTime,
  ParkTime,
  formatDate,
  formatTime,
  modifyDate,
  parkDate,
} from '@/datetime';
import useFlash from '@/hooks/useFlash';
import { PARTY_IDS_KEY } from '@/hooks/useSavedParty';
import kvdb from '@/kvdb';
import onVisible from '@/onVisible';

function loadConfig(): AutoBookConfig {
  const config = kvdb.get<Partial<AutoBookConfig>>(AUTO_BOOK_KEY) ?? {};
  return {
    ...DEFAULT_AUTO_BOOK_CONFIG,
    ...config,
    targetIds: Array.isArray(config.targetIds) ? config.targetIds : [],
    intervalSeconds: Math.max(1, Math.min(30, config.intervalSeconds ?? 3)),
    jitterPercent: Math.max(0, Math.min(100, config.jitterPercent ?? 25)),
    maxMinutesFromNow: Math.max(1, config.maxMinutesFromNow ?? 120),
    webhookUrl: typeof config.webhookUrl === 'string' ? config.webhookUrl : '',
    upgradeExisting: config.upgradeExisting === true,
    resortGuest: config.resortGuest === true,
    resortCheckInDate:
      typeof config.resortCheckInDate === 'string'
        ? config.resortCheckInDate
        : '',
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

/* eslint-disable-next-line react-refresh/only-export-components */
export function isActiveBookingForDate(
  booking: LLMP,
  bookingDate: string,
  now = DateTime.now()
) {
  if (booking.start.date !== bookingDate || !booking.cancellable) return false;
  const currentParkDate = parkDate(now);
  return (
    bookingDate > currentParkDate ||
    (bookingDate === currentParkDate && +booking.end.time > +now.time)
  );
}

/* eslint-disable-next-line react-refresh/only-export-components */
export function coversExpectedParty(
  guestIds: Iterable<string>,
  expectedPartyIds: Set<string>
) {
  const actualGuestIds = new Set(guestIds);
  return (
    expectedPartyIds.size > 0 &&
    Array.from(expectedPartyIds).every(id => actualGuestIds.has(id))
  );
}

const randMs = (min: number, max: number) =>
  min + Math.floor(Math.random() * (max - min));
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

type WebhookEvent =
  | {
      type: 'started';
      parkName: string;
      date: string;
      targetNames: string[];
      intervalSeconds: number;
      maxMinutesFromNow: number;
      upgradeExisting: boolean;
    }
  | {
      type: 'booked';
      experienceName: string;
      startTime: string;
      date: string;
      guestCount: number;
      guestNames: string[];
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
      guestNames: string[];
    }
  | {
      type: 'ticket_issue';
      reason: IneligibleReason;
      parkName: string;
      date: string;
    }
  | { type: 'skip'; experienceName: string; reason: string }
  | { type: 'error'; message: string; parkName: string; date: string }
  | { type: 'stopped'; reason: string; parkName: string; date: string }
  | {
      type: 'scheduled';
      parkName: string;
      date: string;
      opensAt: string;
      targetNames: string[];
    };

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
        {
          name: 'Poll Interval',
          value: `${event.intervalSeconds}s`,
          inline: true,
        },
        {
          name: 'Time Window',
          value: `≤ ${event.maxMinutesFromNow} min from now`,
          inline: true,
        },
        {
          name: 'Upgrade Existing',
          value: event.upgradeExisting ? 'Yes' : 'No',
          inline: true,
        },
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
        {
          name: `Guests (${event.guestCount})`,
          value: event.guestNames.join('\n'),
          inline: false,
        }
      );
      if (event.remaining > 0) {
        fields.push({
          name: `Still to Book (${event.remaining})`,
          value: event.remainingNames.join('\n'),
          inline: false,
        });
      } else {
        fields.push({
          name: 'Queue',
          value: '🎉 All targets booked!',
          inline: false,
        });
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
        {
          name: `Guests (${event.guestCount})`,
          value: event.guestNames.join('\n'),
          inline: false,
        }
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
      title = '⏭️ Ride Skipped';
      description = `**${event.experienceName}**`;
      color = 0xffa500;
      fields.push({ name: 'Reason', value: event.reason, inline: false });
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
    case 'scheduled':
      title = '🕐 Auto Book Scheduled';
      description = `**${event.parkName}** on **${event.date}**`;
      color = 0x5865f2;
      fields.push(
        { name: 'Booking Window Opens', value: event.opensAt, inline: false },
        {
          name: `Rides Queued (${event.targetNames.length})`,
          value: event.targetNames.join('\n'),
          inline: false,
        }
      );
      break;
  }

  try {
    const response = await fetch(url.trim(), {
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
    if (!response.ok) {
      console.error(`Webhook failed: HTTP ${response.status}`);
    }
  } catch (error) {
    // Notifications are best-effort and must never alter Disney booking flow.
    console.error(error);
  }
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
  const resort = use(ResortContext);
  const [flashElem, flash] = useFlash();
  const [config, setConfig] = useState(loadConfig);
  const [status, setStatus] = useState<AutoBookStatus>({
    message: config.enabled ? 'Starting' : 'Off',
    running: false,
  });
  const checking = useRef(false);
  const startWebhookFingerprint = useRef<string | null>(null);
  const scheduledWebhookFingerprintRef = useRef<string | null>(null);
  const programmaticStopRef = useRef(false);
  const wasEnabledRef = useRef(config.enabled);
  const lastSkipReasonsRef = useRef<Map<string, string>>(new Map());
  const consecutiveSameSkipCountRef = useRef(0);
  const dryRunBookedIdsRef = useRef<Set<string>>(new Set());
  const dryRunUpgradeTimesRef = useRef<Map<string, ParkTime>>(new Map());
  const completedTargetIdsRef = useRef<Set<string>>(new Set());

  const saveConfig = useCallback((newConfig: AutoBookConfig) => {
    newConfig = {
      ...newConfig,
      intervalSeconds: Math.max(1, Math.min(30, newConfig.intervalSeconds)),
      jitterPercent: Math.max(0, Math.min(100, newConfig.jitterPercent)),
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
      startWebhookFingerprint.current = null;
      scheduledWebhookFingerprintRef.current = null;
      setStatus(status => ({
        ...status,
        message: status.message.startsWith('Booked ') ? status.message : 'Off',
        running: false,
        lastChecked: undefined,
        waitingUntilMs: undefined,
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
    let expectedPartyIds = new Set<string>();
    let partySelectionFingerprint = '';
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

    // Throttle slow-polling while waiting far from the booking window.
    // Resets to 0 each time the effect re-runs (config/park change).
    let waitThrottleUntilMs = 0;

    async function checkOnce() {
      if (checking.current || cancelled) return;
      // While waiting for the booking window to open and far from it,
      // skip polls that fall within the slow-poll period.
      if (Date.now() < waitThrottleUntilMs) return;
      checking.current = true;
      const lastChecked = DateTime.now().toString();
      safeSetStatus({
        lastChecked,
        message: config.dryRun ? '[DRY RUN] Checking' : 'Checking',
        running: true,
      });

      // Wait until the booking eligibility window opens
      const isWDW = resort.id === 'WDW';
      // DLR standard Multi Pass: same-day after park check-in (no pre-day gate, API enforces)
      // WDW non-resort: 3 days; WDW resort / DLR Premier Pass: 7 days
      const daysAhead = config.resortGuest ? 7 : isWDW ? 3 : 0;
      const validCheckInDate =
        isWDW &&
        config.resortGuest &&
        /^\d{4}-\d{2}-\d{2}$/.test(config.resortCheckInDate) &&
        config.resortCheckInDate <= bookingDate
          ? config.resortCheckInDate
          : bookingDate;
      const eligibilityDate = modifyDate(validCheckInDate, -daysAhead);
      const openHour = isWDW || config.resortGuest ? (isWDW ? 7 : 10) : 0;
      const nowDt = DateTime.now();

      let notYetEligible: boolean;
      if (nowDt.date < eligibilityDate) {
        notYetEligible = true;
      } else if (
        nowDt.date === eligibilityDate &&
        (isWDW || config.resortGuest)
      ) {
        // Apply 7am clock-time gate for all WDW guests and DLR Premier Pass holders.
        // Must use raw clock seconds (midnight-based), NOT ParkTime valueOf() which is
        // 4am-relative and wraps — causing pre-7am times like 1:30am to compare as
        // greater than 7am, incorrectly marking the window as open.
        const nowClockSecs =
          nowDt.time.hour * 3600 + nowDt.time.minute * 60 + nowDt.time.second;
        notYetEligible = nowClockSecs < openHour * 3600;
      } else {
        notYetEligible = false;
      }

      if (notYetEligible) {
        const tzLabel = isWDW ? 'EST' : 'PST';
        const opensAt =
          isWDW || config.resortGuest
            ? `${formatDate(eligibilityDate)} at 7:00 AM ${tzLabel}`
            : 'Day of visit, after park check-in';
        const msg =
          isWDW || config.resortGuest
            ? `Waiting — booking window opens ${opensAt}`
            : `Waiting — booking available day of visit after park check-in`;
        // Compute stable countdown target (seconds remaining until eligibility)
        const dayDiff = Math.round(
          (new Date(eligibilityDate + 'T12:00:00').getTime() -
            new Date(nowDt.date + 'T12:00:00').getTime()) /
            86400000
        );
        const nowSecsFromMidnight =
          nowDt.time.hour * 3600 + nowDt.time.minute * 60 + nowDt.time.second;
        const secsRemaining = Math.max(
          0,
          dayDiff * 86400 + openHour * 3600 - nowSecsFromMidnight
        );
        const waitingUntilMs = Date.now() + secsRemaining * 1000;
        // Throttle polling to at most once per 60s when > 5 min from window.
        // Cap so we never throttle past the 5-minute mark (go aggressive then).
        const AGGRESSIVE_THRESHOLD_S = 300; // 5 minutes
        if (secsRemaining > AGGRESSIVE_THRESHOLD_S) {
          const throttleMs = Math.min(
            60_000,
            (secsRemaining - AGGRESSIVE_THRESHOLD_S) * 1000
          );
          waitThrottleUntilMs = Date.now() + throttleMs;
        }
        // Fire scheduled webhook once per unique (park, date, targets) combo
        const scheduledFingerprint = `${park.id}:${bookingDate}:${config.targetIds.join(',')}`;
        if (scheduledWebhookFingerprintRef.current !== scheduledFingerprint) {
          scheduledWebhookFingerprintRef.current = scheduledFingerprint;
          sendWebhook(config.webhookUrl, {
            type: 'scheduled',
            parkName: park.name,
            date: bookingDate,
            opensAt,
            targetNames: config.targetIds.map(id => {
              try {
                return resort.experience(id).name;
              } catch {
                return `Ride (...${id.slice(-4)})`;
              }
            }),
          }).catch(console.error);
        }
        safeSetStatus({
          lastChecked,
          message: msg,
          running: true,
          waitingUntilMs,
        });
        checking.current = false;
        return;
      }

      try {
        const targetIds = new Set(config.targetIds);
        const savedPartyIds = kvdb.get<string[]>(PARTY_IDS_KEY) ?? [];
        const normalizedPartyIds = Array.isArray(savedPartyIds)
          ? [...new Set(savedPartyIds)].sort()
          : [];
        const nextPartyFingerprint = normalizedPartyIds.join(',');
        if (
          nextPartyFingerprint !== partySelectionFingerprint ||
          expectedPartyIds.size === 0
        ) {
          partySelectionFingerprint = nextPartyFingerprint;
          ll.setPartyIds(normalizedPartyIds);
          if (normalizedPartyIds.length > 0) {
            expectedPartyIds = new Set(normalizedPartyIds);
          } else {
            const party = await ll.guests(undefined, bookingDate);
            expectedPartyIds = new Set(
              [...party.eligible, ...party.ineligible].map(guest => guest.id)
            );
          }
        }
        if (expectedPartyIds.size === 0) {
          safeSetStatus({
            lastChecked,
            message: 'No guests found for the selected party',
            running: true,
          });
          return;
        }
        if (expectedPartyIds.size > ll.rules.maxPartySize) {
          stopAutoBooker(
            `Selected party has ${expectedPartyIds.size} guests; maximum is ${ll.rules.maxPartySize}`
          );
          return;
        }

        const allExps = (await ll.experiences(park, bookingDate)).filter(
          isFlexExperience
        );

        // Recomputed fresh every cycle (not once per effect run) so that LLs which
        // expire mid-poll are noticed immediately, without waiting on the periodic
        // plans refresh (see PlansProvider) to catch redemptions/cancellations.
        const currentBookings = plans
          .filter(isLLMP)
          .filter(booking => isActiveBookingForDate(booking, bookingDate));
        const bookedGuestIdsByExperience = new Map<string, Set<string>>();
        for (const booking of currentBookings) {
          const guestIds =
            bookedGuestIdsByExperience.get(booking.experience.id) ??
            new Set<string>();
          booking.guests.forEach(guest => guestIds.add(guest.id));
          bookedGuestIdsByExperience.set(booking.experience.id, guestIds);
        }
        const isFullyBooked = (experienceId: string) => {
          const bookedGuestIds = bookedGuestIdsByExperience.get(experienceId);
          return (
            !!bookedGuestIds &&
            coversExpectedParty(bookedGuestIds, expectedPartyIds)
          );
        };

        // Send started webhook on first check of each session (has real ride names)
        const startFingerprint = `${park.id}:${bookingDate}:${config.targetIds.join(',')}`;
        if (startWebhookFingerprint.current !== startFingerprint) {
          startWebhookFingerprint.current = startFingerprint;
          lastSkipReasonsRef.current = new Map();
          consecutiveSameSkipCountRef.current = 0;
          dryRunBookedIdsRef.current = new Set();
          dryRunUpgradeTimesRef.current = new Map();
          completedTargetIdsRef.current = new Set();
          const targetNames = config.targetIds.map(
            id =>
              allExps.find(e => e.id === id)?.name ??
              `Ride (...${id.slice(-4)})`
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
          .filter(
            exp =>
              !isFullyBooked(exp.id) &&
              !completedTargetIdsRef.current.has(exp.id) &&
              !(config.dryRun && dryRunBookedIdsRef.current.has(exp.id))
          )
          .sort(
            (a, b) =>
              (targetOrder.get(a.id) ?? Infinity) -
              (targetOrder.get(b.id) ?? Infinity)
          );

        const allBooked =
          config.targetIds.length > 0 &&
          config.targetIds.every(
            id =>
              isFullyBooked(id) ||
              completedTargetIdsRef.current.has(id) ||
              (config.dryRun && dryRunBookedIdsRef.current.has(id))
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
        let firstSkipPermanent = false;
        const skipsThisCycle = new Map<string, string>();
        // Only these reasons truly require manual user action and won't self-resolve
        // while we keep polling. Everything else (tier/cap reached, too early,
        // redemption needed, transient errors) can clear up on its own — e.g. once a
        // guest scans into an existing Lightning Lane (Tier 1 or otherwise), their
        // active-selection count drops and a new booking becomes possible — so those
        // must never trigger the auto-stop.
        const PERMANENT_REASONS = new Set<IneligibleReason>([
          'GENIE_PLUS_NEEDED',
          'MULTI_PASS_NEEDED',
          'NOT_IN_PARTY',
        ]);
        const setFirstSkip = (msg: string, permanent = false) => {
          if (firstSkipMsg === null) {
            firstSkipMsg = msg;
            firstSkipPermanent = permanent;
          }
        };

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
              const skipReason = `next slot ${formatTime(nextTime)} too far`;
              skipsThisCycle.set(experience.id, skipReason);
              setFirstSkip(`${name}: ${skipReason}`);
              continue;
            }
          }

          let guests: Guest[] = [];
          let ticketIssue: IneligibleReason | undefined;
          try {
            await sleep(randMs(150, 500));
            const guestData = await ll.guests(experience, bookingDate);
            const eligibleById = new Map(
              guestData.eligible.map(guest => [guest.id, guest])
            );
            const ineligibleById = new Map(
              guestData.ineligible.map(guest => [guest.id, guest])
            );
            const intendedIneligible = Array.from(expectedPartyIds)
              .map(id => ineligibleById.get(id))
              .filter((guest): guest is Guest => !!guest);
            const missingGuestIds = Array.from(expectedPartyIds).filter(
              id => !eligibleById.has(id) && !ineligibleById.has(id)
            );
            guests = Array.from(expectedPartyIds)
              .map(id => eligibleById.get(id))
              .filter((guest): guest is Guest => !!guest);

            if (config.dryRun) {
              guests = Array.from(expectedPartyIds)
                .map(id => eligibleById.get(id) ?? ineligibleById.get(id))
                .filter((guest): guest is Guest => !!guest);
            } else if (
              intendedIneligible.length === expectedPartyIds.size &&
              intendedIneligible.every(
                guest => guest.ineligibleReason === 'EXPERIENCE_LIMIT_REACHED'
              )
            ) {
              completedTargetIdsRef.current.add(experience.id);
              continue;
            } else if (
              intendedIneligible.length > 0 ||
              missingGuestIds.length > 0 ||
              guests.length !== expectedPartyIds.size
            ) {
              const ticketGuest = intendedIneligible.find(
                guest =>
                  guest.ineligibleReason === 'INVALID_PARK_ADMISSION' ||
                  guest.ineligibleReason === 'PARK_RESERVATION_NEEDED'
              );
              ticketIssue = ticketGuest?.ineligibleReason;
              const reason =
                ticketIssue ?? intendedIneligible[0]?.ineligibleReason;
              const skipMsg =
                missingGuestIds.length > 0
                  ? `${missingGuestIds.length} selected guest${missingGuestIds.length === 1 ? '' : 's'} missing from eligibility response`
                  : reason === 'TIER_LIMIT_REACHED'
                    ? 'tier-1 already selected — waiting for redemption or expiry'
                    : reason === 'EXPERIENCE_LIMIT_REACHED'
                      ? 'party at 3-LL cap — waiting for a redemption or expiry'
                      : reason === 'REDEMPTION_NEEDED'
                        ? 'guest must redeem an existing LL first'
                        : reason?.startsWith('TOO_EARLY')
                          ? 'too early for this selection'
                          : `not available for the full party (${reason ?? 'unknown'})`;
              skipsThisCycle.set(experience.id, skipMsg);
              setFirstSkip(
                `${name}: ${skipMsg}`,
                !!reason && PERMANENT_REASONS.has(reason)
              );
              guests = [];
            }
          } catch (error: any) {
            console.error(error);
            const guestFailReason = `guests call failed (${error?.name ?? 'error'})`;
            skipsThisCycle.set(experience.id, guestFailReason);
            setFirstSkip(`${name}: ${guestFailReason}`);
            continue;
          }
          if (ticketIssue && !config.dryRun) {
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

          try {
            await sleep(randMs(200, 600));
            const offer = await ll.offer(experience, guests, {
              date: bookingDate,
            });
            const offeredGuestIds = new Set(
              offer.guests.eligible.map(guest => guest.id)
            );
            if (
              offer.guests.ineligible.length > 0 ||
              !coversExpectedParty(offeredGuestIds, expectedPartyIds)
            ) {
              const offerReason =
                'offer changed and no longer covers the full party';
              skipsThisCycle.set(experience.id, offerReason);
              setFirstSkip(`${name}: ${offerReason}`);
              continue;
            }
            if (!isCloseEnough(offer.start, config.maxMinutesFromNow)) {
              const offerReason = `offer at ${formatTime(offer.start.time)} too far`;
              skipsThisCycle.set(experience.id, offerReason);
              setFirstSkip(`${name}: ${offerReason}`);
              continue;
            }
            const booking = config.dryRun
              ? {
                  experience: { id: experience.id, name: experience.name },
                  start: offer.start,
                  guests,
                }
              : await ll.book(offer);
            const bookedGuestIds = new Set(
              booking.guests.map(guest => guest.id)
            );
            if (
              !config.dryRun &&
              !coversExpectedParty(bookedGuestIds, expectedPartyIds)
            ) {
              refreshPlans();
              const msg = `Booked ${booking.experience.name}, but Disney omitted part of the party — verify reservations manually`;
              safeSetStatus({ lastChecked, message: msg, running: false });
              flash(msg, 'error');
              stopAutoBooker(msg);
              return;
            }
            if (config.dryRun) {
              dryRunBookedIdsRef.current.add(booking.experience.id);
              dryRunUpgradeTimesRef.current.set(
                booking.experience.id,
                booking.start.time
              );
            } else {
              completedTargetIdsRef.current.add(booking.experience.id);
              refreshPlans();
            }
            const justBookedIds = config.dryRun
              ? new Set(dryRunBookedIdsRef.current)
              : new Set(completedTargetIdsRef.current);
            for (const id of config.targetIds) {
              if (isFullyBooked(id)) justBookedIds.add(id);
            }
            const remaining = config.targetIds.filter(
              id => !justBookedIds.has(id)
            ).length;
            const remainingNames = config.targetIds
              .filter(id => !justBookedIds.has(id))
              .map(
                id =>
                  allExps.find(e => e.id === id)?.name ??
                  `Ride (...${id.slice(-4)})`
              );
            await sendWebhook(config.webhookUrl, {
              type: 'booked',
              experienceName:
                (config.dryRun ? '[DRY RUN] ' : '') + booking.experience.name,
              startTime: booking.start.time.toString(),
              date: booking.start.date,
              guestCount: booking.guests.length,
              guestNames: (booking.guests as Guest[]).map(g => g.name),
              remaining,
              remainingNames,
            });
            const bookedMsg = `Booked ${booking.experience.name} for ${formatTime(booking.start.time)}`;
            if (config.dryRun) {
              safeSetStatus({
                lastChecked,
                message:
                  remaining > 0
                    ? `[DRY RUN] ${bookedMsg} — ${remaining} target${remaining === 1 ? '' : 's'} remaining`
                    : `[DRY RUN] ${bookedMsg}`,
                running: remaining > 0 || !!config.upgradeExisting,
              });
              if (remaining === 0 && !config.upgradeExisting) {
                stopAutoBooker(
                  '[DRY RUN] All targets simulated — no actual reservations were made'
                );
              }
              return;
            }
            if (remaining === 0 && !config.upgradeExisting) {
              safeSetStatus({
                lastChecked,
                message: bookedMsg,
                running: false,
              });
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
              skipsThisCycle.set(experience.id, 'offer unavailable');
              setFirstSkip(`${name}: offer unavailable`);
              continue;
            }
            throw error;
          }
        }

        const skippedCount = skipsThisCycle.size;
        const finalMsg = firstSkipMsg
          ? `${skippedCount}/${experiences.length} skipped — ${firstSkipMsg}`
          : allBooked
            ? 'All targets booked'
            : 'No targets currently available';
        safeSetStatus({ lastChecked, message: finalMsg, running: true });
        // Send per-ride skip webhooks only when the reason changes
        for (const [id, reason] of skipsThisCycle) {
          if (lastSkipReasonsRef.current.get(id) !== reason) {
            lastSkipReasonsRef.current.set(id, reason);
            const expName =
              experiences.find(e => e.id === id)?.name ??
              `Ride (...${id.slice(-4)})`;
            sendWebhook(config.webhookUrl, {
              type: 'skip',
              experienceName: expName,
              reason,
            }).catch(console.error);
          }
        }
        // Clear stale entries for rides no longer skipped
        Array.from(lastSkipReasonsRef.current.keys())
          .filter((id: string) => !skipsThisCycle.has(id))
          .forEach((id: string) => lastSkipReasonsRef.current.delete(id));
        // Auto-stop on consecutive permanent eligibility failures only — never for
        // self-resolving states like the 3-LL cap or "too early", which should just
        // keep waiting/polling until they naturally clear.
        if (firstSkipMsg && firstSkipPermanent) {
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
          if (!config.dryRun) {
            const bookedTargets = currentBookings.filter(
              booking =>
                targetIds.has(booking.experience.id) &&
                isFullyBooked(booking.experience.id)
            );
            for (const existingBooking of bookedTargets) {
              if (cancelled) break;
              const exp = allExps.find(
                e => e.id === existingBooking.experience.id
              );
              if (!exp) continue;
              let upGuests: Guest[] = [];
              try {
                await sleep(randMs(150, 500));
                const gd = await ll.guests(exp, bookingDate);
                const eligibleById = new Map(
                  gd.eligible.map(guest => [guest.id, guest])
                );
                upGuests = Array.from(expectedPartyIds)
                  .map(id => eligibleById.get(id))
                  .filter((guest): guest is Guest => !!guest);
              } catch {
                continue;
              }
              if (upGuests.length !== expectedPartyIds.size) continue;
              try {
                await sleep(randMs(200, 600));
                const offer = await ll.offer(exp, upGuests, {
                  booking: existingBooking,
                });
                const offeredGuestIds = new Set(
                  offer.guests.eligible.map(guest => guest.id)
                );
                if (
                  offer.guests.ineligible.length > 0 ||
                  !coversExpectedParty(offeredGuestIds, expectedPartyIds)
                ) {
                  continue;
                }
                if (
                  +offer.start.time < +existingBooking.start.time &&
                  isCloseEnough(offer.start, config.maxMinutesFromNow)
                ) {
                  const upgraded = await ll.book(offer);
                  refreshPlans();
                  await sendWebhook(config.webhookUrl, {
                    type: 'upgraded',
                    experienceName: upgraded.experience.name,
                    startTime: upgraded.start.time.toString(),
                    oldTime: existingBooking.start.time.toString(),
                    date: upgraded.start.date,
                    guestCount: upgraded.guests.length,
                    guestNames: (upgraded.guests as Guest[]).map(g => g.name),
                  });
                  safeSetStatus({
                    lastChecked,
                    message: `Upgraded ${upgraded.experience.name} to ${formatTime(upgraded.start.time)} (was ${formatTime(existingBooking.start.time)})`,
                    running: true,
                  });
                  break;
                }
              } catch {
                continue;
              }
            }
          }
          // Dry run: check dry-run-booked rides for upgrades using a fresh offer
          if (config.dryRun) {
            for (const id of dryRunBookedIdsRef.current) {
              if (cancelled) break;
              if (!targetIds.has(id)) continue;
              const currentTime = dryRunUpgradeTimesRef.current.get(id);
              if (!currentTime) continue;
              const exp = allExps.find(e => e.id === id);
              if (!exp) continue;
              let upGuests: Guest[] = [];
              try {
                await sleep(randMs(150, 500));
                const gd = await ll.guests(exp, bookingDate);
                upGuests =
                  gd.eligible.length > 0
                    ? gd.eligible.slice(0, ll.rules.maxPartySize)
                    : (gd.ineligible as unknown as Guest[]).slice(
                        0,
                        ll.rules.maxPartySize
                      );
              } catch {
                continue;
              }
              if (upGuests.length === 0) continue;
              try {
                await sleep(randMs(200, 600));
                const offer = await ll.offer(exp, upGuests, {
                  date: bookingDate,
                });
                if (
                  +offer.start.time < +currentTime &&
                  isCloseEnough(offer.start, config.maxMinutesFromNow)
                ) {
                  dryRunUpgradeTimesRef.current.set(exp.id, offer.start.time);
                  await sendWebhook(config.webhookUrl, {
                    type: 'upgraded',
                    experienceName: '[DRY RUN] ' + exp.name,
                    startTime: offer.start.time.toString(),
                    oldTime: currentTime.toString(),
                    date: offer.start.date,
                    guestCount: upGuests.length,
                    guestNames: upGuests.map(g => g.name),
                  });
                  safeSetStatus({
                    lastChecked,
                    message: `[DRY RUN] Upgraded ${exp.name} to ${formatTime(offer.start.time)} (was ${formatTime(currentTime)})`,
                    running: true,
                  });
                  break;
                }
              } catch {
                continue;
              }
            }
          }
        }
      } catch (error: any) {
        console.error(error);
        const status = error?.response?.status;
        const transient =
          error?.name === 'RateLimitExceeded' ||
          status === 0 ||
          status === 408 ||
          status === 429 ||
          status >= 500;
        if (transient) {
          safeSetStatus({
            lastChecked,
            message:
              error?.name === 'RateLimitExceeded'
                ? 'Rate limited — will retry'
                : `Temporary network/server error${status ? ` (${status})` : ''} — will retry`,
            running: true,
          });
          return;
        }
        const errMsg =
          error?.message ?? error?.name ?? 'Auto-book check failed';
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
        stopAutoBooker(`Error: ${errMsg}`);
      } finally {
        checking.current = false;
      }
    }

    checkOnce();
    let timeoutId: ReturnType<typeof setTimeout>;
    const removeVisibleListener = onVisible(() => {
      waitThrottleUntilMs = 0;
      refreshPlans();
      void checkOnce();
    });
    const onOnline = () => {
      waitThrottleUntilMs = 0;
      refreshPlans();
      void checkOnce();
    };
    addEventListener('online', onOnline);
    const scheduleNext = () => {
      if (cancelled) return;
      const base = config.intervalSeconds * 1000;
      const j = (config.jitterPercent ?? 25) / 100;
      const delay =
        j > 0
          ? randMs(Math.round(base * (1 - j)), Math.round(base * (1 + j)))
          : base;
      timeoutId = setTimeout(async () => {
        await checkOnce();
        scheduleNext();
      }, delay);
    };
    scheduleNext();
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      removeVisibleListener();
      removeEventListener('online', onOnline);
    };
  }, [bookingDate, config, flash, ll, park, plans, refreshPlans, saveConfig]);

  return (
    <AutoBookContext value={{ config, saveConfig, status }}>
      {children}
      {flashElem}
    </AutoBookContext>
  );
}
