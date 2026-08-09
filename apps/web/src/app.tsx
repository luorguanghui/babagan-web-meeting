import { Navigate, Route, Routes, useParams } from 'react-router-dom';

import { CreateMeetingPage } from './pages/create-meeting-page.js';
import { JoinLobbyPage } from './pages/join-lobby-page.js';
import { MeetingErrorBoundary } from './components/error-boundary.js';
import { LanguageSelector } from './components/language-selector.js';
import { LanguageProvider } from './i18n/i18n.js';

function MeetingLobbyRoute() {
  const { slug } = useParams();
  return slug ? <JoinLobbyPage slug={slug} /> : <Navigate to="/create" replace />;
}

export function App() {
  return <LanguageProvider><div className="app-root"><LanguageSelector /><MeetingErrorBoundary><Routes><Route path="/create" element={<CreateMeetingPage />} /><Route path="/m/:slug" element={<MeetingLobbyRoute />} /><Route path="/meetings/:slug" element={<MeetingLobbyRoute />} /><Route path="*" element={<Navigate to="/create" replace />} /></Routes></MeetingErrorBoundary></div></LanguageProvider>;
}
