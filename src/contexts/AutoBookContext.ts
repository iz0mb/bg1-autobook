import { createContext } from 'react';

export const AUTO_BOOK_KEY = 'bg1.ll.autoBook';

export interface AutoBookConfig {
  enabled: boolean;
  intervalSeconds: number;
  jitterPercent: number;
  maxMinutesFromNow: number;
  targetIds: string[];
  webhookUrl: string;
  upgradeExisting: boolean;
  dryRun: boolean;
  resortGuest: boolean;
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
  webhookUrl: '',
  upgradeExisting: false,
  dryRun: false,
  resortGuest: false,
};

export default createContext<AutoBookContextValue>({
  config: DEFAULT_AUTO_BOOK_CONFIG,
  saveConfig: () => undefined,
  status: { message: 'Off', running: false },
});
