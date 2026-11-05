import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import App from './App.jsx';
import Login from './Login.jsx';
import Register from './Register.jsx';
import './style.css';
import { AuthProvider, GuestPage, PrivatePage } from './Auth.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
      <Routes>
        <Route path="/" element={<PrivatePage><App /></PrivatePage>} />
        <Route path="/login" element={<GuestPage><Login /></GuestPage>} />
        <Route path="/register" element={<GuestPage><Register /></GuestPage>} />
      </Routes>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
