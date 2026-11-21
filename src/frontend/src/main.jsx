import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import JournalPage from './pages/JournalPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import RecordPage from './pages/RecordPage.jsx';
import HistoryPage from './pages/HistoryPage.jsx';
import EntryPage from './pages/EntryPage.jsx';
import ReflectionPage from './pages/ReflectionPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import AppShell from './components/layout/AppShell.jsx';
import './styles/index.css';
import { AuthProvider, GuestPage, PrivatePage } from './auth/Auth.jsx';
import { ThemeProvider } from './theme/ThemeProvider.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route element={<PrivatePage><AppShell /></PrivatePage>}>
              <Route index element={<JournalPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/history" element={<HistoryPage />} />
              <Route path="/journal/:id" element={<EntryPage />} />
              <Route path="/reflection" element={<ReflectionPage />} />
              <Route path="/record" element={<RecordPage />} />
            </Route>
            <Route path="/login" element={<GuestPage><LoginPage /></GuestPage>} />
            <Route path="/register" element={<GuestPage><RegisterPage /></GuestPage>} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
);
