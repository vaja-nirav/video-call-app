import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

// Pages
import Home from './pages/Home';
import MeetingRoom from './pages/MeetingRoom';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public Homepage Dashboard */}
        <Route path="/" element={<Home />} />

        {/* Public Video Call Rooms */}
        <Route path="/room/:roomId" element={<MeetingRoom />} />

        {/* Fallback redirection to dashboard */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
