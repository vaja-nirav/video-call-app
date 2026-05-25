import React, { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { logoutUser } from '../features/authSlice';
import api from '../utils/api';

const Home = () => {
  const [roomCode, setRoomCode] = useState('');
  const [loadingMeeting, setLoadingMeeting] = useState(false);
  const [error, setError] = useState('');
  const [time, setTime] = useState(new Date());

  const navigate = useNavigate();

  // Digital clock update
  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleCreateMeeting = async () => {
    setLoadingMeeting(true);
    setError('');
    try {
      // Send open request to create a guest meeting room
      const response = await api.post('/meetings/create', { title: 'Instant Meeting' });
      const { id } = response.data; // Retrieve room ID (UUID)
      // Save host marker in local browser storage for this room ID
      localStorage.setItem(`meetsync_host_${id}`, 'true');
      navigate(`/room/${id}`);
    } catch (err) {
      console.error(err);
      setError(err.response?.data?.message || 'Failed to create meeting room. Please try again.');
    } finally {
      setLoadingMeeting(false);
    }
  };

  const handleJoinMeeting = (e) => {
    e.preventDefault();
    if (!roomCode.trim()) return;

    // Support both full URL paste and raw room ID inputs
    let cleanCode = roomCode.trim();
    try {
      if (cleanCode.includes('/room/')) {
        const parts = cleanCode.split('/room/');
        cleanCode = parts[parts.length - 1];
      }
    } catch (err) {
      console.warn('URL parsing failed, falling back to raw input code', err);
    }

    if (cleanCode) {
      navigate(`/room/${cleanCode}`);
    }
  };

  const formatTime = (date) => {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const formatDate = (date) => {
    return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  };

  return (
    <div className="min-h-screen bg-dark-bg text-gray-100 flex flex-col relative overflow-hidden">
      {/* Dynamic Background Glows */}
      <div className="absolute top-10 left-10 w-[500px] h-[500px] bg-indigo-900/10 rounded-full blur-[120px] pointer-events-none"></div>
      <div className="absolute bottom-10 right-10 w-[500px] h-[500px] bg-purple-900/10 rounded-full blur-[120px] pointer-events-none"></div>

      {/* Header bar */}
      <header className="z-10 w-full max-w-7xl mx-auto px-6 py-4 flex items-center justify-between border-b border-dark-border">
        <div className="flex items-center space-x-3">
          <div className="bg-indigo-600 p-2.5 rounded-xl shadow-lg shadow-indigo-600/30">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </div>
          <span className="text-xl font-bold tracking-tight bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent">
            MeetSync
          </span>
        </div>

        <div className="flex items-center space-x-4">
          <div className="text-right hidden sm:block">
            <p className="text-xs text-gray-400 font-semibold uppercase">{formatDate(time)}</p>
            <p className="text-sm font-bold text-indigo-400">{formatTime(time)}</p>
          </div>
          <div className="h-8 w-px bg-dark-border hidden sm:block"></div>
          <div className="flex items-center space-x-3 bg-dark-card/50 border border-dark-border rounded-lg p-1.5 pr-4">
            <div className="w-8 h-8 rounded-md bg-indigo-600 flex items-center justify-center font-bold text-white uppercase text-sm">
              G
            </div>
            <div className="text-left leading-none">
              <p className="text-xs text-gray-400">Welcome</p>
              <p className="text-sm font-semibold text-white mt-0.5">Guest User</p>
            </div>
          </div>
        </div>
      </header>

      {/* Main Panel */}
      <main className="z-10 flex-grow max-w-7xl mx-auto w-full px-6 flex flex-col lg:flex-row items-center justify-center lg:justify-between py-12 gap-12">
        <div className="flex-1 max-w-xl text-center lg:text-left space-y-8">
          <div className="space-y-4">
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-white leading-tight">
              Premium video calling.<br />
              <span className="bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
                Completely free.
              </span>
            </h1>
            <p className="text-lg text-gray-400 max-w-md mx-auto lg:mx-0">
              We redesigned secure, seamless, real-time group collaboration so that you can join and share instantly from any device.
            </p>
          </div>

          {error && (
            <div className="p-3 bg-red-950/30 border border-red-500/30 text-red-200 text-sm rounded-lg text-center lg:text-left">
              {error}
            </div>
          )}

          <div className="flex flex-col sm:flex-row items-center gap-4 justify-center lg:justify-start">
            <button
              onClick={handleCreateMeeting}
              disabled={loadingMeeting}
              className="w-full sm:w-auto bg-indigo-600 hover:bg-indigo-500 font-semibold px-6 py-3.5 rounded-xl shadow-lg shadow-indigo-600/30 text-white flex items-center justify-center space-x-3 transition-all duration-300 transform hover:-translate-y-0.5 active:scale-95 disabled:opacity-50"
            >
              {loadingMeeting ? (
                <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              ) : (
                <>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                  </svg>
                  <span>New Meeting</span>
                </>
              )}
            </button>

            <form onSubmit={handleJoinMeeting} className="w-full sm:w-auto flex items-center bg-[#08080C] border border-dark-border rounded-xl focus-within:border-indigo-500 focus-within:ring-1 focus-within:ring-indigo-500 transition-all duration-300 p-1">
              <input
                type="text"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value)}
                placeholder="Enter room code or link"
                className="bg-transparent outline-none border-none py-2.5 px-4 text-white text-sm w-full sm:w-60 focus:ring-0"
              />
              <button
                type="submit"
                disabled={!roomCode.trim()}
                className="bg-dark-card hover:bg-dark-hover disabled:opacity-30 disabled:pointer-events-none text-white font-medium text-sm px-5 py-2.5 rounded-lg border border-dark-border transition-all duration-300"
              >
                Join
              </button>
            </form>
          </div>
        </div>

        {/* Carousel Visuals */}
        <div className="flex-1 w-full max-w-lg glassmorphism rounded-3xl p-6 shadow-2xl relative">
          <div className="absolute inset-0 bg-gradient-to-tr from-indigo-500/10 to-purple-500/10 rounded-3xl pointer-events-none"></div>
          <div className="relative aspect-video rounded-2xl overflow-hidden bg-black/40 border border-dark-border flex flex-col justify-center items-center p-6 text-center space-y-4">
            <div className="bg-indigo-600/10 border border-indigo-500/20 text-indigo-400 p-4 rounded-full">
              <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <div className="space-y-1">
              <h3 className="text-lg font-bold text-white">Get a link you can share</h3>
              <p className="text-xs text-gray-400 max-w-xs">
                Click <strong className="text-indigo-400">New Meeting</strong> to get a secure link you can send to people you want to call.
              </p>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="z-10 py-6 text-center text-xs text-gray-500 mt-auto border-t border-dark-border">
        © 2026 MeetSync. Powered by ultra low-latency WebRTC and NestJS.
      </footer>
    </div>
  );
};

export default Home;
