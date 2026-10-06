import type { GeoSource } from './geo.js';
import {
  disabledWeatherPorts,
  locateReportLocation,
  type WeatherPresentationPorts,
} from './weather-adapter.js';

/** Read browser capability only when the user starts a capture, never at mounting. */
function browserGeolocation(): GeoSource | null {
  return typeof navigator === 'undefined' ? null : navigator.geolocation;
}

/**
 * Active report location only. Confirmation and saving remain with the existing
 * WeatherLocationSession and parent DayStore; personal coordinates never become
 * a weather-query point. Creating these ports does not access browser GPS.
 */
export function createBrowserLocationPorts(
  getGeolocation: () => GeoSource | null | undefined = browserGeolocation,
): WeatherPresentationPorts {
  return {
    locationVersionId: null,
    loadWeather: disabledWeatherPorts.loadWeather,
    locate: async (signal) => {
      if (signal.aborted) return { kind: 'unavailable' };
      try {
        return await locateReportLocation(getGeolocation(), signal);
      } catch {
        // Capability getter failures must not expose device or browser details.
        return { kind: 'unavailable' };
      }
    },
  };
}
