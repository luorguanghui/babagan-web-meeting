import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';

import { CreateMeetingPage } from './pages/create-meeting-page.js';
import { JoinLobbyPage } from './pages/join-lobby-page.js';
import { MeetingErrorBoundary } from './components/error-boundary.js';
import { AppShell } from './components/app-shell.js';
import { LanguageProvider } from './i18n/i18n.js';
import { NativeDownloadPage } from './pages/native-download-page.js';
import { HomePage } from './pages/home-page.js';
import { ClientWorkspacePage } from './pages/client-workspace-page.js';
import { useClientHost } from './client/client-host.js';

function MeetingLobbyRoute() {
  const { slug } = useParams();
  return slug ? <JoinLobbyPage slug={slug} /> : <Navigate to="/create" replace />;
}

export function App() {
  const { host } = useClientHost();
  const { pathname } = useLocation();
  const start = host ? '/client' : '/create';
  return <LanguageProvider><AppShell showClientUpdate={pathname !== '/client'}><MeetingErrorBoundary><Routes>
    <Route path="/" element={host ? <Navigate to="/client" replace /> : <HomePage />} />
    <Route path="/client" element={<ClientWorkspacePage />} />
    <Route path="/native" element={host ? <Navigate to="/client" replace /> : <NativeDownloadPage />} />
    <Route path="/create" element={<CreateMeetingPage />} />
    <Route path="/m/:slug" element={<MeetingLobbyRoute />} />
    <Route path="/meetings/:slug" element={<MeetingLobbyRoute />} />
    <Route path="*" element={<Navigate to={start} replace />} />
  </Routes></MeetingErrorBoundary></AppShell></LanguageProvider>;
}
