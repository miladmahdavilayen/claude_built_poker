import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './AuthContext.js';
import { LobbyPage } from './pages/Lobby.js';
import { LoginPage } from './pages/Login.js';
import { TablePage } from './pages/Table.js';

export function App(): React.JSX.Element {
  const { user, loading } = useAuth();

  if (loading) return <div className="page-centered">Loading...</div>;

  return (
    <Routes>
      <Route path="/" element={<Navigate to={user ? '/lobby' : '/login'} replace />} />
      <Route path="/login" element={user ? <Navigate to="/lobby" replace /> : <LoginPage />} />
      <Route path="/lobby" element={user ? <LobbyPage /> : <Navigate to="/login" replace />} />
      <Route path="/table/:tableId" element={user ? <TablePage /> : <Navigate to="/login" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
