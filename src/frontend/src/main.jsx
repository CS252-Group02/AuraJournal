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
import './styles/index.css';
import { AuthProvider, GuestPage, PrivatePage } from './auth/Auth.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/dashboard" element={<PrivatePage><DashboardPage /></PrivatePage>} />
          <Route
            path="/"
            element={
              <PrivatePage>
                <JournalPage />
              </PrivatePage>
            }
          />
          <Route
            path="/login"
            element={
              <GuestPage>
                <LoginPage />
              </GuestPage>
            }
          />
          <Route
            path="/register"
            element={
              <GuestPage>
                <RegisterPage />
              </GuestPage>
            }
          />
          <Route
            path="/record"
            element={
              <PrivatePage>
                <RecordPage />
              </PrivatePage>
            }
          />
          <Route
            path="/history"
            element={
              <PrivatePage>
                <HistoryPage />
              </PrivatePage>
            }
          />
          <Route
            path="/journal/:id"
            element={
              <PrivatePage>
                <EntryPage />
              </PrivatePage>
            }
          />
          <Route
            path="/reflection"
            element={
              <PrivatePage>
                <ReflectionPage />
              </PrivatePage>
            }
          />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
