import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { browserLocationPortsForFlag } from './report/browser-location-ports.js';
import { weatherReferenceFlag } from './report/browser-weather-ports.js';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
const weatherPorts = browserLocationPortsForFlag(
  import.meta.env['VITE_REPORT_LOCATION_ENABLED'],
);
const forecastEnabled = weatherReferenceFlag(
  import.meta.env['VITE_WEATHER_REFERENCE_ENABLED'],
);
createRoot(root).render(
  <App
    forecastEnabled={forecastEnabled}
    {...(weatherPorts ? { weatherPorts } : {})}
  />,
);
