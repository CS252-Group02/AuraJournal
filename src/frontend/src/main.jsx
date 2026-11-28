import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import JournalPage from './pages/JournalPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import RecordPage from './pages/RecordPage.jsx';
import HistoryPage from './pages/HistoryPage.jsx';
import EntryPage from './pages/EntryPage.jsx';
import ReflectionChatPage from './pages/ReflectionChatPage.jsx';
import ReflectionPage from './pages/ReflectionPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import PixelMemoriesPage from './pages/PixelMemoriesPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import AppShell from './components/layout/AppShell.jsx';
import './styles/index.css';
import { AuthProvider, GuestPage, PrivatePage } from './auth/Auth.jsx';
import { ThemeProvider } from './theme/ThemeProvider.jsx';
import { applyMotion } from './features/settings/preferences.js';

applyMotion();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route element={<PrivatePage><AppShell /></PrivatePage>}>
              <Route index element={<JournalPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/memories" element={<PixelMemoriesPage />} />
              <Route path="/history" element={<HistoryPage />} />
              <Route path="/journal/:id" element={<EntryPage />} />
              <Route path="/reflection-chat" element={<ReflectionChatPage />} />
              <Route path="/reflection-chat/:chatId" element={<ReflectionChatPage />} />
              <Route path="/reflection" element={<ReflectionPage />} />
              <Route path="/record" element={<RecordPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
            <Route path="/login" element={<GuestPage><LoginPage /></GuestPage>} />
            <Route path="/register" element={<GuestPage><RegisterPage /></GuestPage>} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
);
