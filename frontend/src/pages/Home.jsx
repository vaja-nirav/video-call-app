import React, { useState, useEffect, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate, Link } from 'react-router-dom';
import { logoutUser } from '../features/authSlice';
import { io } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';
import api from '../utils/api';

const Home = () => {
  const [roomCode, setRoomCode] = useState('');
  const [loadingMeeting, setLoadingMeeting] = useState(false);
  const [error, setError] = useState('');
  const [time, setTime] = useState(new Date());

  // Real-time presence states
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [incomingCall, setIncomingCall] = useState(null);
  const [outgoingCall, setOutgoingCall] = useState(null);

  // Direct Messaging Drawer states
  const [activeChatUser, setActiveChatUser] = useState(null);
  const [messagesMap, setMessagesMap] = useState({}); // { [userId]: [messages] }
  const [unreadMap, setUnreadMap] = useState({}); // { [userId]: count }
  const [chatInput, setChatInput] = useState('');

  // Auto-Match toggle state
  const [autoMatch, setAutoMatch] = useState(true);

  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { isAuthenticated, user } = useSelector((state) => state.auth);

  const socketRef = useRef(null);
  const activeChatUserRef = useRef(null);
  const messagesEndRef = useRef(null);

  // Sync ref to prevent stale closures in real-time socket events
  useEffect(() => {
    activeChatUserRef.current = activeChatUser;
  }, [activeChatUser]);

  // Digital clock update
  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Socket connection and real-time event router
  useEffect(() => {
    if (!isAuthenticated || !user) return;

    const backendUrl = import.meta.env.VITE_API_URL || '';
    const socket = io(backendUrl, {
      extraHeaders: {
        'ngrok-skip-browser-warning': 'true',
      },
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      const wasKicked = localStorage.getItem('meetsync_was_kicked') === '1';
      if (wasKicked) localStorage.removeItem('meetsync_was_kicked');

      const isFirstTime = localStorage.getItem('meetsync_first_time') === 'true';
      socket.emit('register-presence', {
        userId: user.id,
        name: user.name,
        autoMatchEnabled: autoMatch
      });

      // Clean up first time registration flag so subsequent logins or reloads are manual
      if (isFirstTime) {
        localStorage.removeItem('meetsync_first_time');
      }
    });

    socket.on('online-users-list', (usersList) => {
      // Filter out ourself AND anyone currently in a call/busy
      const filtered = usersList.filter(
        (u) => u.userId !== user.id && u.status !== 'BUSY' && !u.isBusy
      );
      setOnlineUsers(filtered);
    });

    socket.on('incoming-ring', ({ callerSocketId, callerName, roomCode }) => {
      setIncomingCall({ callerSocketId, callerName, roomCode });
    });

    socket.on('call-connected', ({ roomCode }) => {
      setOutgoingCall(null);
      setIncomingCall(null);
      localStorage.setItem(`meetsync_host_${roomCode}`, 'true');
      navigate(`/room/${roomCode}`);
    });

    socket.on('auto-match-redirect', ({ roomCode }) => {
      localStorage.setItem(`meetsync_host_${roomCode}`, 'true');
      navigate(`/room/${roomCode}`);
    });

    socket.on('call-declined', () => {
      setOutgoingCall(null);
      alert('Call was declined or canceled.');
    });

    socket.on('call-cancelled', () => {
      setIncomingCall(null);
    });

    socket.on('incoming-direct-message', ({ senderUserId, senderName, content, createdAt }) => {
      // Append text message to history
      setMessagesMap((prev) => {
        const history = prev[senderUserId] || [];
        return {
          ...prev,
          [senderUserId]: [...history, { senderName, content, createdAt, isMe: false }],
        };
      });

      // Increment unread count if we are not actively texting them
      if (!activeChatUserRef.current || activeChatUserRef.current.userId !== senderUserId) {
        setUnreadMap((prev) => ({
          ...prev,
          [senderUserId]: (prev[senderUserId] || 0) + 1,
        }));
      }
    });

    return () => {
      if (socket) {
        socket.disconnect();
      }
    };
  }, [isAuthenticated, user, navigate, autoMatch]);

  // Scroll to bottom of chat when message history changes
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messagesMap, activeChatUser]);

  const handleCreateMeeting = async () => {
    if (!isAuthenticated) {
      navigate('/login');
      return;
    }
    setLoadingMeeting(true);
    setError('');
    try {
      const response = await api.post('/meetings/create', { title: 'Instant Meeting' });
      const { id } = response.data;
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
    if (!isAuthenticated) {
      navigate('/login');
      return;
    }
    if (!roomCode.trim()) return;

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

  // Start Direct Call Ringing
  const handleMakeCall = (targetUser) => {
    const code = uuidv4();
    setOutgoingCall({ 
      targetUserId: targetUser.userId,
      targetName: targetUser.name, 
      roomCode: code 
    });
    if (socketRef.current) {
      socketRef.current.emit('call-user', { targetUserId: targetUser.userId, roomCode: code });
    }
  };

  // Accept Direct Call
  const handleAcceptCall = () => {
    if (incomingCall && socketRef.current) {
      socketRef.current.emit('accept-call', {
        callerSocketId: incomingCall.callerSocketId,
        roomCode: incomingCall.roomCode,
      });
    }
  };

  // Decline or Cancel Call
  const handleDeclineCall = () => {
    if (incomingCall && socketRef.current) {
      socketRef.current.emit('decline-call', { callerSocketId: incomingCall.callerSocketId });
      setIncomingCall(null);
    }
  };

  // Cancel Outgoing Call
  const handleCancelCall = () => {
    if (outgoingCall && socketRef.current) {
      socketRef.current.emit('cancel-call', { targetUserId: outgoingCall.targetUserId });
      setOutgoingCall(null);
    }
  };

  // Open Chat Drawer & Clear Unread
  const handleOpenChat = (targetUser) => {
    setActiveChatUser(targetUser);
    setUnreadMap((prev) => ({
      ...prev,
      [targetUser.userId]: 0,
    }));
  };

  // Send Direct Chat Message
  const handleSendDM = (e) => {
    e.preventDefault();
    if (!chatInput.trim() || !activeChatUser || !socketRef.current) return;

    const payload = {
      targetUserId: activeChatUser.userId,
      content: chatInput.trim(),
    };

    // Emit socket to server
    socketRef.current.emit('send-direct-message', payload);

    // Save locally
    setMessagesMap((prev) => {
      const history = prev[activeChatUser.userId] || [];
      return {
        ...prev,
        [activeChatUser.userId]: [
          ...history,
          {
            senderName: user.name,
            content: chatInput.trim(),
            createdAt: new Date().toISOString(),
            isMe: true,
          },
        ],
      };
    });

    setChatInput('');
  };

  const handleLogout = () => {
    dispatch(logoutUser());
  };

  const formatTime = (date) => {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const formatDate = (date) => {
    return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  };

  return (
    <div className={`${isAuthenticated ? 'h-screen overflow-hidden' : 'min-h-screen'} bg-[#060609] text-gray-100 flex flex-col relative`}>
      {/* Background decoration glows */}
      <div className="absolute top-10 left-10 w-[400px] h-[400px] bg-indigo-900/5 rounded-full blur-[120px] pointer-events-none"></div>
      <div className="absolute bottom-10 right-10 w-[400px] h-[400px] bg-purple-900/5 rounded-full blur-[120px] pointer-events-none"></div>

      {/* Header bar */}
      <header className="z-20 w-full px-6 py-4 flex items-center justify-between border-b border-dark-border bg-dark-bg/60 backdrop-blur-md">
        <div className="flex items-center space-x-3">
          <div className="bg-indigo-600 p-2 rounded-xl shadow-lg shadow-indigo-600/30">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </div>
          <span className="text-lg font-bold tracking-tight bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent">
            MeetSync
          </span>
        </div>

        <div className="flex items-center space-x-4">
          <div className="text-right hidden sm:block">
            <p className="text-xxs text-gray-500 font-semibold uppercase">{formatDate(time)}</p>
            <p className="text-xs font-bold text-indigo-400">{formatTime(time)}</p>
          </div>
          <div className="h-6 w-px bg-dark-border hidden sm:block"></div>
          
          {isAuthenticated ? (
            <div className="flex items-center space-x-3 bg-dark-card/40 border border-dark-border rounded-xl p-1 pr-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center font-bold text-white uppercase text-xs">
                {user?.name?.[0] || 'U'}
              </div>
              <div className="text-left hidden xs:block">
                <p className="text-xxs text-gray-500">Welcome</p>
                <p className="text-xs font-bold text-white leading-none mt-0.5">{user?.name}</p>
              </div>
              <button
                onClick={handleLogout}
                className="ml-2 hover:bg-red-500/10 p-1.5 rounded-lg text-gray-400 hover:text-red-400 transition-colors"
                title="Logout"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </button>
            </div>
          ) : (
            <Link
              to="/login"
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs px-4 py-2 rounded-xl transition-all duration-300 transform active:scale-95 shadow-md shadow-indigo-600/20"
            >
              Sign In
            </Link>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex-grow overflow-hidden relative flex flex-col justify-center">
        {isAuthenticated ? (
          /* Premium Vertical Snap-Scroll Feed Container */
          <div className="relative h-[calc(100vh-69px)] w-full">
            
            {/* Premium Vertical Snap-Scroll Feed Container */}

            <div className="h-full overflow-y-scroll snap-y snap-mandatory scrollbar-none scroll-smooth">
              {onlineUsers.length === 0 ? (
                /* Empty Radar Pulse Searching Screen */
                <div className="h-full snap-start flex flex-col justify-center items-center space-y-6 bg-[#060609] text-center p-6 relative">
                  <div className="relative w-32 h-32 flex items-center justify-center">
                    <div className="absolute inset-0 rounded-full border border-indigo-500/10 animate-ping duration-[3s]"></div>
                    <div className="absolute inset-4 rounded-full border border-indigo-500/20 animate-pulse duration-[2s]"></div>
                    <div className="absolute inset-8 rounded-full border border-indigo-500/30 animate-ping"></div>
                    <div className="bg-indigo-600/10 border border-indigo-500/20 text-indigo-400 p-6 rounded-full shadow-lg shadow-indigo-600/10 z-10">
                      <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </div>
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-white tracking-wide">Searching for active users...</h2>
                    <p className="text-xs text-gray-400 max-w-xs mt-2 mx-auto leading-relaxed">
                      Once a user registers or logs in, their live calling card will automatically appear here!
                    </p>
                  </div>
                </div>
              ) : (
                /* User Card Loops */
                onlineUsers.map((item, index) => (
                  <div 
                    key={item.userId}
                    className="h-full w-full snap-start flex flex-col justify-center items-center relative overflow-hidden bg-[#060609] px-4"
                  >
                    {/* Decorative glowing mesh behind avatar */}
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[350px] h-[350px] bg-gradient-to-tr from-indigo-500/5 to-purple-500/5 rounded-full blur-[90px] pointer-events-none"></div>

                    {/* Profile Card Container */}
                    <div className="w-full max-w-sm glassmorphism glassmorphism-glow rounded-3xl p-8 text-center flex flex-col items-center space-y-6 z-10 border border-dark-border/60 hover:scale-[1.01] transition-transform duration-300">
                      
                      {/* Glowing Avatar */}
                      <div className="relative w-24 h-24 flex items-center justify-center">
                        <div className="absolute inset-0 rounded-full border border-green-500/20 animate-pulse"></div>
                        <div className="absolute inset-2 rounded-full border border-green-500/30 animate-ping duration-[3.5s]"></div>
                        <div className="w-16 h-16 rounded-full bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center font-bold text-white text-2xl uppercase shadow-lg shadow-indigo-600/30 border border-dark-border">
                          {item.name[0]}
                        </div>
                        
                        {/* Floating Active Badge */}
                        <span className={`absolute bottom-1 right-2 w-3.5 h-3.5 border-2 border-[#060609] rounded-full ${item.status === 'BUSY' || item.isBusy ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]' : 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]'}`}></span>
                      </div>

                      {/* Meta User Information */}
                      <div className="space-y-1.5">
                        <h2 className="text-xl font-bold tracking-tight text-white flex items-center justify-center space-x-1.5">
                          <span>{item.name}</span>
                        </h2>
                        {item.status === 'BUSY' || item.isBusy ? (
                          <p className="text-xxs tracking-wider uppercase font-semibold text-red-400 bg-red-500/10 border border-red-500/20 px-2.5 py-1 rounded-full animate-pulse">
                            🔴 In another call
                          </p>
                        ) : (
                          <p className="text-xxs tracking-wider uppercase font-semibold text-green-400 bg-green-500/10 border border-green-500/20 px-2.5 py-1 rounded-full">
                            🟢 Available for call
                          </p>
                        )}
                      </div>

                      {/* Dual Interaction Buttons */}
                      <div className="w-full flex flex-col space-y-3 pt-3">
                        {/* Call Button */}
                        <button
                          onClick={() => handleMakeCall(item)}
                          disabled={item.status === 'BUSY' || item.isBusy}
                          className={`w-full font-bold py-3.5 rounded-xl shadow-md flex items-center justify-center space-x-2 transition-all duration-300 transform active:scale-95 hover:-translate-y-0.5 ${item.status === 'BUSY' || item.isBusy ? 'bg-gray-800/40 border border-gray-700/30 text-gray-500 cursor-not-allowed opacity-40 shadow-none' : 'bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-indigo-600/20 cursor-pointer'}`}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                          <span>{item.status === 'BUSY' || item.isBusy ? 'Busy in another call' : `Call ${item.name} Now`}</span>
                        </button>

                        {/* Message Button */}
                        <button
                          onClick={() => handleOpenChat(item)}
                          className="w-full bg-dark-card/60 hover:bg-dark-card border border-dark-border text-gray-300 hover:text-white font-semibold py-3.5 rounded-xl flex items-center justify-center space-x-2 transition-all duration-300 transform active:scale-95 cursor-pointer relative"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                          </svg>
                          <span>Send Message</span>

                          {/* Unread Alert Badge */}
                          {(unreadMap[item.userId] || 0) > 0 && (
                            <span className="absolute -top-1.5 -right-1.5 min-w-5 h-5 bg-red-500 text-white text-[10px] font-black rounded-full flex items-center justify-center px-1 border border-[#060609] animate-bounce">
                              {unreadMap[item.userId]}
                            </span>
                          )}
                        </button>
                      </div>
                    </div>

                    {/* TikTok scroll down guide indicator */}
                    {index < onlineUsers.length - 1 && (
                      <div className="absolute bottom-6 flex flex-col items-center space-y-1 text-gray-600 animate-bounce">
                        <span className="text-[9px] uppercase tracking-widest font-black">Scroll Down</span>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                        </svg>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        ) : (
          /* Guest Room Creation / Join Lobby page */
          <main className="z-10 max-w-7xl mx-auto w-full px-6 flex flex-col lg:flex-row items-center justify-between py-6 lg:py-12 gap-12">
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
        )}
      </div>

      {/* --- FLOATING & OVERLAY COMPONENTS --- */}

      {/* 📞 Outgoing Calling Overlay */}
      {outgoingCall && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-50 animate-fade-in">
          <div className="bg-[#0c0c14] border border-dark-border p-8 rounded-3xl text-center space-y-6 max-w-xs w-full shadow-2xl">
            <div className="relative w-20 h-20 mx-auto flex items-center justify-center">
              <div className="absolute inset-0 rounded-full bg-indigo-500/15 animate-ping"></div>
              <div className="absolute inset-2 rounded-full bg-indigo-500/25 animate-pulse"></div>
              <div className="w-14 h-14 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xl font-bold shadow-lg shadow-indigo-600/30">
                {outgoingCall.targetName[0]}
              </div>
            </div>
            <div>
              <h3 className="text-lg font-bold text-white">Calling {outgoingCall.targetName}...</h3>
              <p className="text-xxs text-gray-500 mt-1 animate-pulse">Waiting for them to accept</p>
            </div>
            <button
              onClick={handleCancelCall}
              className="w-full bg-red-600 hover:bg-red-500 text-white font-semibold py-3 rounded-xl transition-all duration-300 transform active:scale-95 shadow-md shadow-red-600/20 cursor-pointer"
            >
              Cancel Call
            </button>
          </div>
        </div>
      )}

      {/* 🔔 Incoming Call Overlay */}
      {incomingCall && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-50 animate-fade-in">
          <div className="bg-[#0c0c14] border border-dark-border p-8 rounded-3xl text-center space-y-6 max-w-xs w-full shadow-2xl">
            {/* Pulsing ringtones audio player is loaded invisibly */}
            <div className="relative w-20 h-20 mx-auto flex items-center justify-center">
              <div className="absolute inset-0 rounded-full bg-green-500/15 animate-ping"></div>
              <div className="w-14 h-14 rounded-full bg-green-600 flex items-center justify-center text-white text-xl font-bold shadow-lg shadow-green-600/30">
                {incomingCall.callerName[0]}
              </div>
            </div>
            <div>
              <h3 className="text-lg font-bold text-white">Incoming Call</h3>
              <p className="text-xs text-indigo-400 mt-1 font-semibold">{incomingCall.callerName} is calling you</p>
            </div>
            <div className="flex space-x-3">
              <button
                onClick={handleAcceptCall}
                className="flex-1 bg-green-600 hover:bg-green-500 text-white font-bold py-3 rounded-xl shadow-lg shadow-green-600/20 transition-all duration-300 transform active:scale-95 cursor-pointer"
              >
                Accept
              </button>
              <button
                onClick={handleDeclineCall}
                className="flex-1 bg-red-600 hover:bg-red-500 text-white font-semibold py-3 rounded-xl transition-all duration-300 transform active:scale-95 cursor-pointer"
              >
                Decline
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 💬 Quick Chat Slide-out Drawer */}
      <div 
        className={`fixed top-0 right-0 h-full w-full sm:w-96 bg-[#0a0a0f] border-l border-dark-border z-40 shadow-2xl flex flex-col transition-transform duration-500 transform ${activeChatUser ? 'translate-x-0' : 'translate-x-full'}`}
      >
        {activeChatUser && (
          <>
            {/* Drawer Header */}
            <div className="p-4 border-b border-dark-border flex items-center justify-between bg-dark-bg/40">
              <div className="flex items-center space-x-3">
                <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-white text-sm uppercase">
                  {activeChatUser.name[0]}
                </div>
                <div className="leading-tight">
                  <h4 className="text-sm font-bold text-white">{activeChatUser.name}</h4>
                  <p className="text-[10px] text-green-400">Available</p>
                </div>
              </div>
              <button
                onClick={() => setActiveChatUser(null)}
                className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-dark-card transition-colors cursor-pointer"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Chat Messages Feed */}
            <div className="flex-grow overflow-y-auto p-4 space-y-4 scrollbar-thin">
              {(messagesMap[activeChatUser.userId] || []).length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center text-gray-500 space-y-2 p-6">
                  <svg className="w-10 h-10 text-gray-600 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                  <p className="text-xs">No messages yet. Send a quick chat!</p>
                </div>
              ) : (
                (messagesMap[activeChatUser.userId] || []).map((msg, idx) => (
                  <div key={idx} className={`flex flex-col ${msg.isMe ? 'items-end' : 'items-start'}`}>
                    <div 
                      className={`max-w-[75%] rounded-2xl py-2 px-3 text-xs leading-relaxed shadow ${
                        msg.isMe 
                          ? 'bg-indigo-600 text-white rounded-tr-none' 
                          : 'bg-dark-card border border-dark-border text-gray-200 rounded-tl-none'
                      }`}
                    >
                      {msg.content}
                    </div>
                    <span className="text-[9px] text-gray-500 mt-1 px-1">
                      {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Chat Send Input Box */}
            <form onSubmit={handleSendDM} className="p-4 border-t border-dark-border bg-dark-bg/20 flex space-x-2">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Type a message..."
                className="flex-grow bg-[#0c0c12] border border-dark-border focus:border-indigo-500 rounded-xl py-2 px-3 text-xs text-white outline-none transition-all focus:ring-1 focus:ring-indigo-500"
              />
              <button
                type="submit"
                disabled={!chatInput.trim()}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 text-white font-bold p-2.5 rounded-xl transition-all cursor-pointer transform active:scale-95"
              >
                <svg className="w-4 h-4 transform rotate-90" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              </button>
            </form>
          </>
        )}
      </div>

      {/* Footer (Only shown for guest view to maximize swipeable real estate) */}
      {!isAuthenticated && (
        <footer className="z-10 py-4 text-center text-[10px] text-gray-600 mt-auto border-t border-dark-border">
          © 2026 MeetSync. Powered by ultra low-latency WebRTC and NestJS.
        </footer>
      )}
    </div>
  );
};

export default Home;
