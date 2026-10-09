import { Navigate, Route, Routes, useParams } from 'react-router-dom';

import { CreateMeetingPage } from './pages/create-meeting-page.js';
import { JoinLobbyPage } from './pages/join-lobby-page.js';
import { MeetingErrorBoundary } from './components/error-boundary.js';
import { AppShell } from './components/app-shell.js';
import { LanguageProvider } from './i18n/i18n.js';

function MeetingLobbyRoute() {
  const { slug } = useParams();
  return slug ? <JoinLobbyPage slug={slug} /> : <Navigate to="/create" replace />;
}

export function App() {
  return <LanguageProvider><AppShell><MeetingErrorBoundary><Routes><Route path="/create" element={<CreateMeetingPage />} /><Route path="/m/:slug" element={<MeetingLobbyRoute />} /><Route path="/meetings/:slug" element={<MeetingLobbyRoute />} /><Route path="*" element={<Navigate to="/create" replace />} /></Routes></MeetingErrorBoundary></AppShell></LanguageProvider>;
}
