import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { browserLocationPortsForFlag } from './report/browser-location-ports.js';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
const weatherPorts = browserLocationPortsForFlag(
  import.meta.env['VITE_REPORT_LOCATION_ENABLED'],
);
createRoot(root).render(<App {...(weatherPorts ? { weatherPorts } : {})} />);
