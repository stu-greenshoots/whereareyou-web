import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import { App } from './App.jsx';

// Precache the app shell so it opens offline. autoUpdate (see vite.config)
// means a new deploy is picked up on the next load with no prompt.
registerSW({ immediate: true });

const container = document.getElementById('root');
if (container === null) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
