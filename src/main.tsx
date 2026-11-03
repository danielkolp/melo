import '@fontsource-variable/schibsted-grotesk';
import '@fontsource-variable/martian-mono';
import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { clock } from './audio/playback';
import { studio } from './state/useStudio';

// Dev-only handle for inspecting state from the console or automated checks.
if (import.meta.env.DEV) Object.assign(window, { melo: { studio, clock } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
