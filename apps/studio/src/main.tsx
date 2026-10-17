import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@forgon/editor-ui/styles.css';
import { App } from './App.js';
import { loadStudioServices } from './services.js';
import { applyAppearance, readPreferences } from '../../../packages/editor-ui/src/model/preferences.js';

// Apply before the connection status or React tree paints, including on desktop startup.
applyAppearance(readPreferences().appearance, document.documentElement);

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

root.setAttribute('role', 'status');
root.textContent = 'Connecting to Forgon...';

void loadStudioServices().then(studioServices => {
  root.removeAttribute('role');
  createRoot(root).render(
    <StrictMode>
      <App services={studioServices} />
    </StrictMode>,
  );
}).catch(error => {
  root.setAttribute('role', 'alert');
  root.textContent = `Desktop connection failed. Close and reopen Forgon Studio. ${error instanceof Error ? error.message : 'Native host unavailable.'}`;
});
