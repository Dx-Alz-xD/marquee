import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { normalizeRoomCode } from '@shared/util';
import { Lobby } from './pages/Lobby';
import { RoomPage } from './pages/Room';
import './styles.css';

function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const m = path.match(/^\/r\/([A-Za-z0-9-]+)/);
  const code = m ? normalizeRoomCode(m[1]) : null;
  if (code) return <RoomPage key={code} code={code} />;
  return <Lobby invalidCode={m ? m[1] : null} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
