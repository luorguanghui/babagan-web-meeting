import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './app.js';
import { initializeNativeCaptureConnection } from './meeting/native-capture.js';
import './styles.css';

try { initializeNativeCaptureConnection(); } catch { /* Ordinary meetings remain usable when tab storage is blocked. */ }
createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><App /></BrowserRouter></StrictMode>);
