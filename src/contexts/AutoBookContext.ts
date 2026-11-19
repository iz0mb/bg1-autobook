import { createContext } from 'react';

export const AUTO_BOOK_KEY = 'bg1.ll.autoBook';

export interface AutoBookConfig {
  enabled: boolean;
  intervalSeconds: number;
  jitterPercent: number;
  maxMinutesFromNow: number;
  targetIds: string[];
  // Guests assigned to each target; a target without an entry uses the whole party
  guestIdsByTarget: { [experienceId: string]: string[] };
  webhookUrl: string;
  upgradeExisting: boolean;
  dryRun: boolean;
  resortGuest: boolean;
  resortCheckInDate: string;
  resortCheckOutDate: string;
}

export interface AutoBookStatus {
  lastChecked?: string;
  message: string;
  running: boolean;
  waitingUntilMs?: number;
}

export interface AutoBookContextValue {
  config: AutoBookConfig;
  saveConfig: (config: AutoBookConfig) => void;
  status: AutoBookStatus;
}

export const DEFAULT_AUTO_BOOK_CONFIG: AutoBookConfig = {
  enabled: false,
  intervalSeconds: 3,
  jitterPercent: 25,
  maxMinutesFromNow: 120,
  targetIds: [],
  guestIdsByTarget: {},
  webhookUrl: '',
  upgradeExisting: false,
  dryRun: false,
  resortGuest: false,
  resortCheckInDate: '',
  resortCheckOutDate: '',
};

export function sanitizeGuestIdsByTarget(
  value: unknown
): AutoBookConfig['guestIdsByTarget'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, ids]) => {
      const guestIds = Array.isArray(ids)
        ? ids.filter((g): g is string => typeof g === 'string')
        : [];
      return guestIds.length > 0 ? [[id, [...new Set(guestIds)]]] : [];
    })
  );
}

export default createContext<AutoBookContextValue>({
  config: DEFAULT_AUTO_BOOK_CONFIG,
  saveConfig: () => undefined,
  status: { message: 'Off', running: false },
});
