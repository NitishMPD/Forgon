import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@forgon/editor-ui/styles.css';
import { App } from './App.js';
import { loadStudioServices } from './services.js';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

void loadStudioServices().then(studioServices => {
  createRoot(root).render(
    <StrictMode>
      <App services={studioServices} />
    </StrictMode>,
  );
}).catch(error => {
  root.setAttribute('role', 'alert');
  root.textContent = `Desktop connection failed. Close and reopen Forgon Studio. ${error instanceof Error ? error.message : 'Native host unavailable.'}`;
});
