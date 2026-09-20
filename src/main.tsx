import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import DetectorPage from './DetectorPage';
import FeedbackWidget from './Feedback';
import { ManagePage } from './Subscribe';
import './styles.css';

// One public page. /manage keeps its own route because that link arrives in
// every email and text.
const path = window.location.pathname;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {path.startsWith('/manage') ? <ManagePage /> : <><DetectorPage /><FeedbackWidget /></>}
  </StrictMode>,
);
