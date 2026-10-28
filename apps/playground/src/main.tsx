import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
// The dashboard's design tokens and base styles (ADR 020), so both apps look the same.
import '../../dashboard/src/styles/tokens.css';
import '../../dashboard/src/styles/base.css';
import '../../dashboard/src/styles/components.css';
import './styles/playground.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
