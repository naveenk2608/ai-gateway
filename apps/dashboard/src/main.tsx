import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { applyTheme, storedTheme } from './shell/theme.js';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/shell.css';

// Before the first render, so a light-theme viewer never sees a dark frame.
applyTheme(storedTheme());

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
