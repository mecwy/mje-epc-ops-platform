import { createRoot } from 'react-dom/client';
import { FieldApp } from './FieldApp.js';
import '../style.css';

// A code opened in a tab that already shows this page starts the page over with it.
window.addEventListener('hashchange', () => {
  if (window.location.hash.startsWith('#e=')) window.location.reload();
});
const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
createRoot(root).render(<FieldApp />);
