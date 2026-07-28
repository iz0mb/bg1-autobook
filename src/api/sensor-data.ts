interface SensorDataModule {
  getSensorData(): Promise<string> | string;
  resetSensorData(): void;
}

let mod: SensorDataModule | undefined;
let loadPromise: Promise<void> | undefined;

const FALLBACK_SENSOR_DATA_URL =
  'https://joelface.github.io/bg1/sensor-data.js';

function ensureLoaded(): Promise<void> | void {
  if (mod) return;
  if (!loadPromise) {
    const localUrl = import.meta.url.replace(/[^/]*$/, 'sensor-data.js');
    loadPromise = import(/* @vite-ignore */ localUrl)
      .catch(() => import(/* @vite-ignore */ FALLBACK_SENSOR_DATA_URL))
      .then(m => {
        mod = m as SensorDataModule;
      });
  }
  return loadPromise;
}

export function getSensorData(): Promise<string> | string {
  const pending = ensureLoaded();
  if (pending) return pending.then(() => mod!.getSensorData());
  return mod!.getSensorData();
}

export function resetSensorData(): void {
  mod?.resetSensorData();
}
