import { use, useEffect, useState } from 'react';

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
import { DateTime, formatTime } from '@/datetime';

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
      jitterPercent: saved.jitterPercent != null ? Math.max(0, Math.min(100, Number(saved.jitterPercent) || 0)) : config.jitterPercent,
      maxMinutesFromNow:
        Number(saved.maxMinutesFromNow) || config.maxMinutesFromNow,
      webhookUrl: typeof saved.webhookUrl === 'string' ? saved.webhookUrl : '',
      enabled: !!saved.enabled,
      upgradeExisting: saved.upgradeExisting === true,
      dryRun: saved.dryRun === true,
      resortGuest: saved.resortGuest === true,
    };
  } catch {
    return config;
  }
}

export default function AutoBooker() {
  const { config, saveConfig, status } = use(AutoBookContext);
  const { bookingDate } = use(BookingDateContext);
  const { park } = use(ParkContext);
  const { experiences, refreshExperiences, loaderElem } =
    use(ExperiencesContext);

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
      jitterPercent: Math.max(0, Math.min(100, Number(draft.jitterPercent) || 0)),
      maxMinutesFromNow: Number(draft.maxMinutesFromNow) || 120,
      webhookUrl: draft.webhookUrl || '',
      enabled: !!draft.enabled,
      upgradeExisting: !!draft.upgradeExisting,
      dryRun: !!draft.dryRun,
      resortGuest: !!draft.resortGuest,
    };

    localStorage.setItem(AUTO_BOOK_KEY, JSON.stringify(cleanDraft));
    saveConfig(cleanDraft);

    alert(
      `Saved Auto Booker\nEnabled: ${cleanDraft.enabled}\nTargets: ${cleanDraft.targetIds.length}`
    );

    history.back();
  };

  const now = DateTime.now().time;

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
        <label className="flex items-center gap-x-2 mt-2 font-semibold text-orange-600">
          <input
            type="checkbox"
            checked={draft.dryRun}
            onChange={event => update({ dryRun: event.currentTarget.checked })}
          />
          Dry run — simulate bookings, no real reservations
        </label>
        <label className="flex items-center gap-x-2 mt-2 font-semibold">
          <input
            type="checkbox"
            checked={draft.resortGuest}
            onChange={event => update({ resortGuest: event.currentTarget.checked })}
          />
          Disney resort hotel guest
        </label>
        <p className="text-xs text-gray-500 mt-1 ml-6">
          Resort guests can book 7 days ahead at 7:00 AM; non-resort guests 3 days ahead.
          Enable auto-book early and it will wait until your window opens.
        </p>
        <p className="mt-2 text-sm text-gray-600">
          Status: {status.message}
          {status.lastChecked && (
            <> at {formatTime(status.lastChecked.split('T')[1] ?? '')}</>
          )}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 mt-2">
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
            {[1, 2, 3].map(seconds => (
              <option value={seconds} key={seconds}>
                {seconds} sec
              </option>
            ))}
          </select>
        </label>

        <label>
          <span className="block text-xs font-semibold uppercase text-gray-500">
            Max from now
          </span>
          <input
            className="w-full mt-1 border rounded px-2 py-1"
            type="number"
            min="1"
            step="5"
            value={draft.maxMinutesFromNow}
            onChange={event =>
              update({ maxMinutesFromNow: Number(event.currentTarget.value) })
            }
          />
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
              <option value={p} key={p}>{p === 0 ? 'None' : `±${p}%`}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold uppercase text-gray-500">
            Discord webhook
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
                  .then(() => alert('Webhook sent!'))
                  .catch(e => alert('Webhook failed: ' + String(e)));
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
                  <span className="block font-semibold">{exp.name}</span>
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
      <FloatingButton
        disabled={draft.enabled && draft.targetIds.length === 0}
        onClick={save}
      >
        Save Auto Booker
      </FloatingButton>
    </Screen>
  );
}
