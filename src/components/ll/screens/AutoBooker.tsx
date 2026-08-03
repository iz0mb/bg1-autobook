import { use, useEffect, useRef, useState } from 'react';

import { FlexExperience } from '@/api/ll';
import FloatingButton from '@/components/FloatingButton';
import Screen from '@/components/Screen';
import { Time } from '@/components/Time';
import AutoBookContext, {
  AUTO_BOOK_KEY,
  AutoBookConfig,
} from '@/contexts/AutoBookContext';
import BookingDateContext from '@/contexts/BookingDateContext';
import ExperiencesContext from '@/contexts/ExperiencesContext';
import ParkContext from '@/contexts/ParkContext';
import ResortContext from '@/contexts/ResortContext';
import { DateTime, formatTime } from '@/datetime';
import useFlash from '@/hooks/useFlash';

import RefreshButton from './RefreshButton';

function isFlexExperience(exp: unknown): exp is FlexExperience {
  return !!(exp as FlexExperience).flex;
}

function loadSavedAutoBookConfig(config: AutoBookConfig): AutoBookConfig {
  try {
    const saved = JSON.parse(localStorage.getItem(AUTO_BOOK_KEY) || 'null');

    if (!saved) return config;

    return {
      ...config,
      ...saved,
      targetIds: Array.isArray(saved.targetIds) ? saved.targetIds : [],
      intervalSeconds: Number(saved.intervalSeconds) || config.intervalSeconds,
      jitterPercent:
        saved.jitterPercent != null
          ? Math.max(0, Math.min(100, Number(saved.jitterPercent) || 0))
          : config.jitterPercent,
      maxMinutesFromNow:
        Number(saved.maxMinutesFromNow) || config.maxMinutesFromNow,
      webhookUrl: typeof saved.webhookUrl === 'string' ? saved.webhookUrl : '',
      enabled: !!saved.enabled,
      upgradeExisting: saved.upgradeExisting === true,
      dryRun: saved.dryRun === true,
      resortGuest: saved.resortGuest === true,
      resortCheckInDate:
        typeof saved.resortCheckInDate === 'string'
          ? saved.resortCheckInDate
          : '',
    };
  } catch {
    return config;
  }
}

export default function AutoBooker() {
  const { config, saveConfig, status } = use(AutoBookContext);
  const { bookingDate } = use(BookingDateContext);
  const { park } = use(ParkContext);
  const resort = use(ResortContext);
  const { experiences, refreshExperiences, loaderElem } =
    use(ExperiencesContext);
  const [flashElem, flash] = useFlash();

  const [draft, setDraft] = useState<AutoBookConfig>(() =>
    loadSavedAutoBookConfig(config)
  );

  const targetIds = new Set(draft.targetIds);
  const targetOrder = new Map(draft.targetIds.map((id, i) => [id, i]));
  const targetExperiences = experiences
    .filter(isFlexExperience)
    .filter(exp => exp.park.id === park.id)
    .sort(
      (a, b) =>
        +!targetIds.has(a.id) - +!targetIds.has(b.id) ||
        (targetOrder.get(a.id) ?? Infinity) -
          (targetOrder.get(b.id) ?? Infinity) ||
        a.name.localeCompare(b.name)
    );

  useEffect(() => {
    setDraft(loadSavedAutoBookConfig(config));
  }, [config]);

  useEffect(() => {
    if (targetExperiences.length === 0) refreshExperiences();
  }, [refreshExperiences, targetExperiences.length]);

  const update = (patch: Partial<AutoBookConfig>) => {
    setDraft(draft => ({ ...draft, ...patch }));
  };

  const toggleTarget = (id: string) => {
    const ids = new Set(draft.targetIds);
    ids[ids.has(id) ? 'delete' : 'add'](id);
    update({ targetIds: [...ids] });
  };

  const save = () => {
    const cleanDraft: AutoBookConfig = {
      ...draft,
      targetIds: Array.isArray(draft.targetIds) ? draft.targetIds : [],
      intervalSeconds: Number(draft.intervalSeconds) || 3,
      jitterPercent: Math.max(
        0,
        Math.min(100, Number(draft.jitterPercent) || 0)
      ),
      maxMinutesFromNow: Number(draft.maxMinutesFromNow) || 120,
      webhookUrl: draft.webhookUrl || '',
      enabled: !!draft.enabled,
      upgradeExisting: !!draft.upgradeExisting,
      dryRun: !!draft.dryRun,
      resortGuest: !!draft.resortGuest,
      resortCheckInDate: draft.resortCheckInDate || '',
    };

    localStorage.setItem(AUTO_BOOK_KEY, JSON.stringify(cleanDraft));
    saveConfig(cleanDraft);
    flash('Settings saved!');
    setTimeout(() => history.back(), 800);
  };

  const now = DateTime.now().time;

  // Live countdown to booking window
  const waitingUntilMsRef = useRef<number | undefined>(undefined);
  waitingUntilMsRef.current = status.waitingUntilMs;
  const [countdown, setCountdown] = useState('');
  const isWaiting = status.waitingUntilMs != null;
  useEffect(() => {
    if (!isWaiting) {
      setCountdown('');
      return;
    }
    const tick = () => {
      const target = waitingUntilMsRef.current;
      if (target == null) {
        setCountdown('');
        return;
      }
      const ms = target - Date.now();
      if (ms <= 0) {
        setCountdown('Opening now…');
        return;
      }
      const s = Math.floor(ms / 1000);
      const d = Math.floor(s / 86400);
      const h = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      setCountdown(
        d > 0
          ? `${d}d ${h}h ${m}m`
          : h > 0
            ? `${h}h ${m}m ${sec}s`
            : `${m}m ${sec}s`
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isWaiting]);

  return (
    <Screen
      title="Auto Booker"
      theme={park.theme}
      buttons={
        <RefreshButton name="Experiences" onClick={refreshExperiences} />
      }
    >
      <div className="py-3">
        <label className="flex items-center gap-x-2 font-semibold">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={event => update({ enabled: event.currentTarget.checked })}
          />
          Auto book matching Lightning Lanes
        </label>
        <label className="flex items-center gap-x-2 mt-2 font-semibold">
          <input
            type="checkbox"
            checked={draft.upgradeExisting}
            onChange={event =>
              update({ upgradeExisting: event.currentTarget.checked })
            }
          />
          Upgrade existing bookings to earlier times
        </label>
        <label className="flex items-center gap-x-2 mt-2 font-semibold">
          <input
            type="checkbox"
            checked={draft.resortGuest}
            onChange={event =>
              update({ resortGuest: event.currentTarget.checked })
            }
          />
          {resort.id === 'WDW'
            ? 'Disney resort hotel guest'
            : 'Lightning Lane Premier Pass holder'}
        </label>
        <p className="text-xs text-gray-500 mt-1 ml-6">
          {resort.id === 'WDW'
            ? 'Resort hotel guests can book from 7 days before check-in at 7:00 AM EST; non-resort guests 3 days before each park day.'
            : draft.resortGuest
              ? 'Premier Pass holders can book 7 days ahead at 7:00 AM PST.'
              : 'Standard Multi Pass bookings open after you check into the park on the day of your visit.'}{' '}
          Enable auto-book early and it will wait until your window opens.
        </p>
        {resort.id === 'WDW' && draft.resortGuest && (
          <label className="block mt-2 ml-6">
            <span className="block text-xs font-semibold uppercase text-gray-500">
              Resort check-in date
            </span>
            <input
              className="mt-1 border rounded px-2 py-1"
              type="date"
              value={draft.resortCheckInDate}
              onChange={event =>
                update({ resortCheckInDate: event.currentTarget.value })
              }
            />
            <span className="block text-xs text-gray-400 mt-1">
              Optional. Used to open later park days with the stay window.
            </span>
          </label>
        )}
        <label className="flex items-center gap-x-2 mt-2 font-semibold text-orange-600">
          <input
            type="checkbox"
            checked={draft.dryRun}
            onChange={event => update({ dryRun: event.currentTarget.checked })}
          />
          Dry run — simulate bookings, no real reservations
        </label>
        <p className="mt-2 text-sm text-gray-600">
          Status: {status.message}
          {countdown && (
            <span className="ml-1 font-semibold text-blue-600">
              ({countdown})
            </span>
          )}
          {status.lastChecked && (
            <>
              <br />
              Last checked: {formatTime(status.lastChecked.split('T')[1] ?? '')}
            </>
          )}
        </p>
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold uppercase text-gray-500">
            Discord webhook
            <span className="ml-1 normal-case font-normal text-gray-400">
              (optional)
            </span>
          </span>
          {draft.webhookUrl ? (
            <button
              className="text-xs underline text-blue-600"
              onClick={() => {
                fetch(draft.webhookUrl.trim(), {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    embeds: [
                      {
                        title: '🔧 Webhook Test',
                        description: 'bg1 Auto Book webhook is working!',
                        color: 0x5865f2,
                        timestamp: new Date().toISOString(),
                        footer: { text: 'bg1 Auto Book' },
                      },
                    ],
                  }),
                })
                  .then(() => flash('Webhook sent!'))
                  .catch(e => flash('Webhook failed: ' + String(e), 'error'));
              }}
            >
              Test
            </button>
          ) : null}
        </div>
        <input
          className="w-full border rounded px-2 py-1"
          type="url"
          value={draft.webhookUrl}
          onChange={event => update({ webhookUrl: event.currentTarget.value })}
          placeholder="https://discord.com/api/webhooks/..."
        />
        {draft.webhookUrl && (
          <span
            className={`block text-xs mt-1 ${/^https:\/\/discord\.com\/api\/webhooks\/\d+\/.+/.test(draft.webhookUrl.trim()) ? 'text-green-600' : 'text-red-500'}`}
          >
            {/^https:\/\/discord\.com\/api\/webhooks\/\d+\/.+/.test(
              draft.webhookUrl.trim()
            )
              ? '✓ Valid Discord webhook'
              : '✗ Must be a Discord webhook URL'}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 mt-3">
        <label>
          <span className="block text-xs font-semibold uppercase text-gray-500">
            Poll every
          </span>
          <select
            className="w-full mt-1 border rounded px-2 py-1"
            value={draft.intervalSeconds}
            onChange={event =>
              update({ intervalSeconds: Number(event.currentTarget.value) })
            }
          >
            {[1, 2, 3, 5, 10, 30].map(seconds => (
              <option value={seconds} key={seconds}>
                {seconds} sec
              </option>
            ))}
          </select>
        </label>

        <label>
          <span className="block text-xs font-semibold uppercase text-gray-500">
            Interval jitter
          </span>
          <select
            className="w-full mt-1 border rounded px-2 py-1"
            value={draft.jitterPercent ?? 25}
            onChange={event =>
              update({ jitterPercent: Number(event.currentTarget.value) })
            }
          >
            {[0, 10, 25, 50].map(p => (
              <option value={p} key={p}>
                {p === 0 ? 'None' : `±${p}%`}
              </option>
            ))}
          </select>
        </label>

        <label className="col-span-2">
          <span className="block text-xs font-semibold uppercase text-gray-500">
            Max mins from now
          </span>
          <div className="flex items-center gap-2 mt-1">
            <input
              className="w-24 border rounded px-2 py-1"
              type="number"
              min="1"
              step="5"
              value={draft.maxMinutesFromNow}
              onChange={event =>
                update({ maxMinutesFromNow: Number(event.currentTarget.value) })
              }
            />
            <span className="text-xs text-gray-400">
              Same-day only — advance bookings are unaffected.
            </span>
          </div>
        </label>
      </div>

      <h2>Targets</h2>
      <p className="text-sm text-gray-600">
        Booking date: {bookingDate}. Today&apos;s cutoff is within{' '}
        {draft.maxMinutesFromNow} minutes of <Time time={now} />. Selected
        targets are checked first, in the order you add them.
      </p>

      {targetExperiences.length === 0 ? (
        <p>No Lightning Lane experiences loaded for this park yet.</p>
      ) : (
        <ul className="dividers mt-3">
          {targetExperiences.map(exp => (
            <li key={exp.id}>
              <label className="flex items-center gap-x-3 py-2">
                <input
                  type="checkbox"
                  checked={targetIds.has(exp.id)}
                  onChange={() => toggleTarget(exp.id)}
                />
                <span className="flex-1 leading-tight">
                  <span className="block font-semibold">
                    {exp.name}
                    {exp.experienced && (
                      <span className="ml-1.5 inline-block align-middle text-xs font-medium bg-green-100 text-green-700 rounded px-1.5 py-0.5">
                        Booked
                      </span>
                    )}
                  </span>
                  <span className="text-sm text-gray-600">
                    {targetOrder.has(exp.id) && (
                      <>
                        Priority {(targetOrder.get(exp.id) ?? 0) + 1}
                        {' | '}
                      </>
                    )}
                    Next LL:{' '}
                    {exp.flex.nextAvailableTime ? (
                      <Time time={exp.flex.nextAvailableTime} />
                    ) : (
                      'none'
                    )}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {loaderElem}
      {flashElem}
      <FloatingButton
        disabled={draft.enabled && draft.targetIds.length === 0}
        onClick={save}
      >
        Save Auto Booker
      </FloatingButton>
    </Screen>
  );
}
