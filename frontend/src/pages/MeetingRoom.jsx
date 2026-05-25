import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { io } from 'socket.io-client';
import api from '../utils/api';

// Public Google STUN servers for WebRTC NAT bypassing over the internet
const iceConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

const MeetingRoom = () => {
  const { roomId } = useParams();
  const navigate = useNavigate();

  // Custom display name for guest meetings
  const [displayName, setDisplayName] = useState(localStorage.getItem('meetsync_name') || '');

  // Host and Guest Knocking states (like Google Meet)
  const isHost = localStorage.getItem(`meetsync_host_${roomId}`) === 'true';
  const [knockingRequests, setKnockingRequests] = useState([]); // Array of { requesterSocketId, name } for host notification
  const [knockingState, setKnockingState] = useState('idle'); // 'idle' | 'knocking' | 'admitted' | 'denied'

  // Unread messages notification badge state
  const [unreadMessages, setUnreadMessages] = useState(0);

  // UI state
  const [joined, setJoined] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [remoteAudioBlocked, setRemoteAudioBlocked] = useState(false);
  
  // Drawer states
  const [activeDrawer, setActiveDrawer] = useState(null); // 'chat' | 'participants' | null
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');

  // Clear unread message count when active drawer is set to chat (properly initialized)
  useEffect(() => {
    if (activeDrawer === 'chat') {
      setUnreadMessages(0);
    }
  }, [activeDrawer]);
  
  // Dynamic WebRTC states
  const [peers, setPeers] = useState([]); // List of { socketId, name, stream, isMuted, isCameraOff, isHandRaised }

  // Refs for tracking streams and socket connections across renders
  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const peerConnectionsRef = useRef(new Map()); // socketId => RTCPeerConnection
  const localVideoRef = useRef(null);
  const originalCameraStateRef = useRef(true); // Tracks camera status before screen sharing starts

  // Active Speaker States & Refs
  const [activeSpeakers, setActiveSpeakers] = useState(new Set());
  const speakerAnalyzersRef = useRef(new Map()); // registry of socketId/local => cleanupFn

  const attachMediaStream = (element, stream, shouldPlay = true) => {
    if (!element || !stream) return;
    const streamChanged = element.srcObject !== stream;
    if (element.srcObject !== stream) {
      element.srcObject = stream;
    }

    if (shouldPlay && (streamChanged || element.paused)) {
      const playPromise = element.play();
      if (playPromise?.catch) {
        playPromise.catch((err) => {
          console.warn('Browser blocked remote media autoplay:', err);
          setRemoteAudioBlocked(true);
        });
      }
    }
  };

  const enableRemoteAudio = () => {
    setRemoteAudioBlocked(false);
    document.querySelectorAll('[data-remote-audio="true"]').forEach((element) => {
      const playPromise = element.play();
      if (playPromise?.catch) {
        playPromise.catch(() => setRemoteAudioBlocked(true));
      }
    });
  };

  // Web Audio API Speaking Detection Helper (Optimized low-CPU frame filter)
  const monitorSpeaking = (stream, onSpeakingChange) => {
    if (!stream || stream.getAudioTracks().length === 0) return null;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioCtx();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      let speakingFrames = 0;
      let silentFrames = 0;
      let isSpeaking = false;

      const checkSpeakingVolume = () => {
        if (!stream.active || stream.getAudioTracks().length === 0) {
          audioCtx.close();
          return;
        }
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const averageVolume = sum / bufferLength;

        // Threshold of voice activation
        if (averageVolume > 14) {
          speakingFrames++;
          silentFrames = 0;
          if (speakingFrames >= 2 && !isSpeaking) {
            isSpeaking = true;
            onSpeakingChange(true);
          }
        } else {
          silentFrames++;
          speakingFrames = 0;
          if (silentFrames >= 12 && isSpeaking) {
            isSpeaking = false;
            onSpeakingChange(false);
          }
        }
        timeoutId = setTimeout(checkSpeakingVolume, 100);
      };

      let timeoutId = setTimeout(checkSpeakingVolume, 100);
      return () => {
        clearTimeout(timeoutId);
        if (audioCtx.state !== 'closed') audioCtx.close();
      };
    } catch (err) {
      console.warn('Web Audio API not supported on this platform/context:', err);
      return null;
    }
  };

  // 1. Initial Local Camera Preview Setup (Lobby Phase)
  useEffect(() => {
    const setupLobby = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: 'user',
          },
        });
        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        // Start voice detection for the local user
        if (speakerAnalyzersRef.current.has('local')) {
          speakerAnalyzersRef.current.get('local')();
        }
        const cleanup = monitorSpeaking(stream, (speaking) => {
          setActiveSpeakers((prev) => {
            const copy = new Set(prev);
            if (speaking) copy.add('local');
            else copy.delete('local');
            return copy;
          });
        });
        if (cleanup) speakerAnalyzersRef.current.set('local', cleanup);
      } catch (err) {
        console.error('Failed to access camera/mic preview:', err);
        alert('Could not access your camera or microphone. Please check system permissions.');
      }
    };
    setupLobby();

    return () => {
      // Clean up hardware streams on page departure
      cleanUpStreams();
      disconnectSocket();
    };
  }, []);

  function cleanUpStreams() {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => track.stop());
      screenStreamRef.current = null;
    }
  }

  function disconnectSocket() {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    peerConnectionsRef.current.forEach((pc) => pc.close());
    peerConnectionsRef.current.clear();

    // Clean up active speaker audio analyzers
    speakerAnalyzersRef.current.forEach((cleanup) => cleanup());
    speakerAnalyzersRef.current.clear();
    setActiveSpeakers(new Set());
  }

  // Host actions to Admit or Deny a guest knocking request
  const handleAdmit = (requesterSocketId) => {
    if (socketRef.current) {
      socketRef.current.emit('admit-user', { roomId, requesterSocketId });
    }
    setKnockingRequests((prev) => prev.filter((r) => r.requesterSocketId !== requesterSocketId));
  };

  const handleDeny = (requesterSocketId) => {
    if (socketRef.current) {
      socketRef.current.emit('deny-user', { roomId, requesterSocketId });
    }
    setKnockingRequests((prev) => prev.filter((r) => r.requesterSocketId !== requesterSocketId));
  };

  // Guest action to Knock (Request entry)
  const handleAskToJoin = () => {
    if (!displayName.trim()) {
      alert('Please enter your display name before asking to join.');
      return;
    }
    setKnockingState('knocking');

    const backendUrl = import.meta.env.VITE_API_URL || '';
    const socket = io(backendUrl);
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('ask-to-join', { roomId, name: displayName.trim() });
    });

    socket.on('admission-granted', () => {
      console.log('Admission granted by the host!');
      setKnockingState('admitted');
      handleJoinNow(socket); // Join room using the already connected socket!
    });

    socket.on('admission-denied', () => {
      console.log('Admission denied by the host.');
      setKnockingState('denied');
      socket.disconnect();
      socketRef.current = null;
    });
  };

  // 2. Joining the Video Call Room
  const handleJoinNow = async (existingSocket = null) => {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;

    if (AudioCtx) {
      const ctx = new AudioCtx();
      await ctx.resume();
    }

    if (!displayName.trim()) {
      alert('Please enter your display name before joining.');
      return;
    }
    setJoined(true);

    // Fetch existing historical chat messages from database
    try {
      const chatRes = await api.get(`/meetings/${roomId}/messages`);
      setChatMessages(chatRes.data);
    } catch (err) {
      console.warn('Failed to load past chat messages:', err);
    }

    // Use already connected socket or make a new connection
    if (existingSocket) {
      socketRef.current = existingSocket;
    } else {
      const backendUrl = import.meta.env.VITE_API_URL || '';
      socketRef.current = io(backendUrl);
    }

    const socket = socketRef.current;

    // Join room packet
    socket.emit('join-room', {
      roomId,
      userId: null,
      name: displayName.trim(),
    });

    // Listen for guest join requests (knocking) - only host receives this
    socket.on('knocking-request', ({ requesterSocketId, name }) => {
      console.log(`Knock request from ${name} (${requesterSocketId})`);
      setKnockingRequests((prev) => {
        if (prev.some((req) => req.requesterSocketId === requesterSocketId)) return prev;
        return [...prev, { requesterSocketId, name }];
      });
    });

    // Event: Existing users in room
    socket.on('users-in-room', (peersList) => {
      // Add all existing participants to our React peers state array so their cards render instantly!
      setPeers(peersList.map((peer) => ({
        socketId: peer.socketId,
        name: peer.name,
        stream: null,
        isMuted: false,
        isCameraOff: false,
        isHandRaised: false,
      })));

      peersList.forEach((peer) => {
        // Create an RTC connection pointing to this peer
        const pc = createPeerConnection(peer.socketId, peer.name);
        
        // Create offer if we are the newcomer (mesh initiator)
        initiateCall(peer.socketId, pc);
      });
    });

    // Event: New user joined
    socket.on('user-joined', ({ socketId, name }) => {
      console.log(`User joined: ${name} (${socketId})`);
      // Add them to the peers UI immediately
      setPeers((prev) => {
        if (prev.find((p) => p.socketId === socketId)) return prev;
        return [...prev, { socketId, name, stream: null, isMuted: false, isCameraOff: false, isHandRaised: false }];
      });
    });

    // Event: WebRTC Offer received
    socket.on('webrtc-offer', async ({ fromSocketId, offer }) => {
      console.log(`Received Offer from ${fromSocketId}`);
      
      // Defensive check: ensure the caller is added to the peers state array
      setPeers((prev) => {
        if (prev.find((p) => p.socketId === fromSocketId)) return prev;
        return [...prev, { socketId: fromSocketId, name: 'Guest', stream: null, isMuted: false, isCameraOff: false, isHandRaised: false }];
      });

      let pc = peerConnectionsRef.current.get(fromSocketId);
      if (!pc) {
        pc = createPeerConnection(fromSocketId, 'Guest');
      }

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit('webrtc-answer', {
        toSocketId: fromSocketId,
        answer,
      });
    });

    // Event: WebRTC Answer received
    socket.on('webrtc-answer', async ({ fromSocketId, answer }) => {
      console.log(`Received Answer from ${fromSocketId}`);
      const pc = peerConnectionsRef.current.get(fromSocketId);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      }
    });

    // Event: WebRTC ICE Candidate received
    socket.on('webrtc-ice-candidate', async ({ fromSocketId, candidate }) => {
      const pc = peerConnectionsRef.current.get(fromSocketId);
      if (pc) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error('Error adding ICE candidate:', err);
        }
      }
    });

    // Event: Peer toggled Microphone
    socket.on('peer-toggle-mute', ({ socketId, isMuted }) => {
      setPeers((prev) =>
        prev.map((p) => (p.socketId === socketId ? { ...p, isMuted } : p))
      );
    });

    // Event: Peer toggled Camera
    socket.on('peer-toggle-camera', ({ socketId, isCameraOff }) => {
      setPeers((prev) =>
        prev.map((p) => (p.socketId === socketId ? { ...p, isCameraOff } : p))
      );
    });

    // Event: Peer raised hand
    socket.on('peer-raise-hand', ({ socketId, isHandRaised }) => {
      setPeers((prev) =>
        prev.map((p) => (p.socketId === socketId ? { ...p, isHandRaised } : p))
      );
    });

    // Event: Real-time chat messages
    socket.on('message', (message) => {
      setChatMessages((prev) => [...prev, message]);
      
      // Dynamically increment unread messages count if the chat window is closed
      setActiveDrawer((currentDrawer) => {
        if (currentDrawer !== 'chat') {
          setUnreadMessages((prevUnread) => prevUnread );
        }
        return currentDrawer;
      });
    });

    // Event: User Left Room
    socket.on('user-left', ({ socketId }) => {
      console.log(`User left: ${socketId}`);
      const pc = peerConnectionsRef.current.get(socketId);
      if (pc) {
        pc.close();
        peerConnectionsRef.current.delete(socketId);
      }
      
      // Clean up remote analyzer on user departure
      if (speakerAnalyzersRef.current.has(socketId)) {
        speakerAnalyzersRef.current.get(socketId)();
        speakerAnalyzersRef.current.delete(socketId);
      }
      setActiveSpeakers((prev) => {
        const copy = new Set(prev);
        copy.delete(socketId);
        return copy;
      });

      setPeers((prev) => prev.filter((p) => p.socketId !== socketId));
    });
  };

  // 3. WebRTC Peer Connection Core Logic
  const createPeerConnection = (peerSocketId, peerName) => {
    const pc = new RTCPeerConnection(iceConfiguration);
    peerConnectionsRef.current.set(peerSocketId, pc);

    // Add local media tracks to peer connection
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current);
      });
    }

    // ICE Candidate management
    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit('webrtc-ice-candidate', {
          toSocketId: peerSocketId,
          candidate: event.candidate,
        });
      }
    };

    // Receiving remote audio/video tracks
    pc.ontrack = (event) => {
      console.log(`Attached track from peer ${peerName}`);
      const incomingStream =
        event.streams?.[0] ||
        new MediaStream([event.track]);

      incomingStream.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });

      setPeers((prev) =>
        prev.map((p) => {
          if (p.socketId === peerSocketId) {
            return { ...p, stream: incomingStream };
          }
          return p;
        })
      );

      // Start voice detection for the remote user
      if (speakerAnalyzersRef.current.has(peerSocketId)) {
        speakerAnalyzersRef.current.get(peerSocketId)();
      }
      const cleanup = monitorSpeaking(incomingStream, (speaking) => {
        setActiveSpeakers((prev) => {
          const copy = new Set(prev);
          if (speaking) copy.add(peerSocketId);
          else copy.delete(peerSocketId);
          return copy;
        });
      });
      if (cleanup) speakerAnalyzersRef.current.set(peerSocketId, cleanup);
    };

    // Connection state checking
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        console.warn(`Connection to peer ${peerSocketId} failed or dropped`);
      }
    };

    return pc;
  };

  const initiateCall = async (peerSocketId, pc) => {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      socketRef.current.emit('webrtc-offer', {
        toSocketId: peerSocketId,
        offer,
      });
    } catch (err) {
      console.error('Failed to initiate WebRTC call offer:', err);
    }
  };

  // 4. In-Call Action Handlers
  const handleToggleMic = () => {
    const nextState = !micOn;
    setMicOn(nextState);

    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) audioTrack.enabled = nextState;
    }

    if (socketRef.current) {
      socketRef.current.emit('toggle-mute', { isMuted: !nextState });
    }
  };

  const handleToggleCamera = () => {
    const nextState = !cameraOn;
    setCameraOn(nextState);

    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) videoTrack.enabled = nextState;
    }

    if (socketRef.current) {
      socketRef.current.emit('toggle-camera', { isCameraOff: !nextState });
    }
  };

  const handleToggleHand = () => {
    const nextState = !handRaised;
    setHandRaised(nextState);
    if (socketRef.current) {
      socketRef.current.emit('raise-hand', { isHandRaised: nextState });
    }
  };

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (!chatInput.trim() || !socketRef.current) return;

    socketRef.current.emit('send-message', { content: chatInput.trim() });
    setChatInput('');
  };

  const handleLeaveMeeting = () => {
    cleanUpStreams();
    disconnectSocket();
    navigate('/');
  };

  // 5. Screen Sharing Core Logic
  // eslint-disable-next-line no-unused-vars
  const handleToggleScreenShare = async () => {
    if (isScreenSharing) {
      // Stop Screen Share and restore camera
      stopScreenSharing();
    } else {
      // Start Screen Share
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true, // Only request video for maximum compatibility across all OS/Browsers (avoids TypeError blocks)
        });

        screenStreamRef.current = stream;
        setIsScreenSharing(true);

        // Store original camera state and force camera "On" state for screen sharing
        originalCameraStateRef.current = cameraOn;
        setCameraOn(true);
        if (socketRef.current) {
          socketRef.current.emit('toggle-camera', { isCameraOff: false });
        }

        const screenTrack = stream.getVideoTracks()[0];

        // Replace local camera track in all active RTCPeerConnections
        peerConnectionsRef.current.forEach((pc) => {
          const senders = pc.getSenders();
          const videoSender = senders.find((s) => s.track && s.track.kind === 'video');
          if (videoSender) {
            videoSender.replaceTrack(screenTrack);
          }
        });

        // Local video element display
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        // Detect when user clicks "Stop Sharing" inside browser toolbar
        screenTrack.onended = () => {
          stopScreenSharing();
        };
      } catch (err) {
        console.error('Failed to share screen:', err);
      }
    }
  };

  const stopScreenSharing = async () => {
    setIsScreenSharing(false);
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => track.stop());
      screenStreamRef.current = null;
    }

    // Restore original camera state
    const originalCamOn = originalCameraStateRef.current;
    setCameraOn(originalCamOn);
    if (socketRef.current) {
      socketRef.current.emit('toggle-camera', { isCameraOff: !originalCamOn });
    }

    // Restore local camera video track in all active peer connections
    if (localStreamRef.current) {
      const cameraTrack = localStreamRef.current.getVideoTracks()[0];
      if (cameraTrack) {
        cameraTrack.enabled = originalCamOn;
      }
      
      peerConnectionsRef.current.forEach((pc) => {
        const senders = pc.getSenders();
        const videoSender = senders.find((s) => s.track && s.track.kind === 'video');
        if (videoSender && cameraTrack) {
          videoSender.replaceTrack(cameraTrack);
        }
      });

      // Restore local preview
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
      }
    }
  };

  // 6. Dynamic Grid Layout Helper
  const getGridClasses = (peerCount) => {
    const totalTiles = peerCount + 1; // peers + self
    if (totalTiles === 1) return 'grid-cols-1 max-w-3xl';
    if (totalTiles === 2) return 'grid-cols-1 md:grid-cols-2 max-w-5xl';
    if (totalTiles <= 4) return 'grid-cols-2 max-w-5xl';
    return 'grid-cols-2 lg:grid-cols-3 max-w-6xl';
  };

  // LOBBY PREVIEW SCREEN RENDER
  if (!joined) {
    return (
      <div className="min-h-screen bg-dark-bg text-white flex flex-col items-center justify-center p-6 relative overflow-hidden">
        {/* Glows */}
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-600/10 rounded-full blur-[100px] pointer-events-none"></div>
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-600/10 rounded-full blur-[100px] pointer-events-none"></div>

        <div className="w-full max-w-4xl flex flex-col lg:flex-row items-center justify-center gap-12 z-10">
          {/* Camera preview card */}
          <div className="flex-1 w-full max-w-md bg-dark-card border border-dark-border rounded-2xl overflow-hidden aspect-video shadow-2xl relative flex items-center justify-center">
            {cameraOn ? (
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover scale-x-[-1]"
              />
            ) : (
              <div className="w-20 h-20 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 text-3xl font-bold uppercase">
                {displayName?.slice(0, 2) || 'G'}
              </div>
            )}
            
            {/* Local Stream controls */}
            <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex items-center space-x-4 bg-black/60 backdrop-blur-md rounded-full px-4 py-2 border border-white/5">
              <button
                onClick={() => {
                  const state = !micOn;
                  setMicOn(state);
                  if (localStreamRef.current?.getAudioTracks()[0]) {
                    localStreamRef.current.getAudioTracks()[0].enabled = state;
                  }
                }}
                className={`p-2.5 rounded-full transition-all duration-300 ${micOn ? 'text-white hover:bg-white/10' : 'bg-red-500 text-white'}`}
              >
                {micOn ? (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                  </svg>
                )}
              </button>

              <button
                onClick={() => {
                  const state = !cameraOn;
                  setCameraOn(state);
                  if (localStreamRef.current?.getVideoTracks()[0]) {
                    localStreamRef.current.getVideoTracks()[0].enabled = state;
                  }
                }}
                className={`p-2.5 rounded-full transition-all duration-300 ${cameraOn ? 'text-white hover:bg-white/10' : 'bg-red-500 text-white'}`}
              >
                {cameraOn ? (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* Join Prompt details */}
          <div className="flex-1 w-full max-w-sm flex flex-col space-y-6">
            <div className="space-y-2 text-center lg:text-left">
              <h2 className="text-3xl font-extrabold tracking-tight">Ready to join?</h2>
              <p className="text-gray-400 text-sm">Meeting Room ID: <strong className="text-indigo-400 font-mono">{roomId}</strong></p>
            </div>

            <div className="bg-dark-card border border-dark-border rounded-xl p-4 space-y-3">
              <p className="text-xs text-gray-400 font-semibold uppercase">Enter your display name:</p>
              <input
                type="text"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  localStorage.setItem('meetsync_name', e.target.value);
                }}
                placeholder="e.g. John Doe"
                className="w-full bg-[#08080C] border border-dark-border focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-xl px-4 py-2.5 text-white text-sm outline-none transition-all duration-300"
              />
            </div>

            <div className="flex flex-col space-y-4 w-full">
              {isHost ? (
                // Host joins instantly
                <div className="flex items-center space-x-4">
                  <button
                    onClick={() => handleJoinNow()}
                    className="flex-1 bg-indigo-600 hover:bg-indigo-500 font-semibold py-3 px-6 rounded-xl shadow-lg shadow-indigo-600/30 text-white transition-all duration-300 transform active:scale-95 text-center"
                  >
                    Join Now
                  </button>
                  <button
                    onClick={() => navigate('/')}
                    className="bg-dark-card hover:bg-dark-hover border border-dark-border py-3 px-6 rounded-xl text-gray-300 font-semibold transition-all duration-300 text-sm"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                // Guests must knock (Ask to Join)
                <div className="flex flex-col space-y-3">
                  {knockingState === 'idle' && (
                    <div className="flex items-center space-x-4">
                      <button
                        onClick={handleAskToJoin}
                        className="flex-1 bg-indigo-600 hover:bg-indigo-500 font-semibold py-3 px-6 rounded-xl shadow-lg shadow-indigo-600/30 text-white transition-all duration-300 transform active:scale-95 text-center"
                      >
                        Ask to Join
                      </button>
                      <button
                        onClick={() => navigate('/')}
                        className="bg-dark-card hover:bg-dark-hover border border-dark-border py-3 px-6 rounded-xl text-gray-300 font-semibold transition-all duration-300 text-sm"
                      >
                        Cancel
                      </button>
                    </div>
                  )}

                  {knockingState === 'knocking' && (
                    <div className="bg-dark-card border border-indigo-500/20 rounded-xl p-4 flex flex-col items-center justify-center text-center space-y-3 animate-pulse">
                      <svg className="animate-spin h-6 w-6 text-indigo-400" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      <div>
                        <p className="text-sm font-bold text-white">Asking to join...</p>
                        <p className="text-xs text-gray-400 mt-1">Please wait for the host to admit you.</p>
                      </div>
                    </div>
                  )}

                  {knockingState === 'denied' && (
                    <div className="bg-red-950/20 border border-red-500/30 rounded-xl p-4 flex flex-col items-center justify-center text-center space-y-3">
                      <div className="text-red-400 text-2xl">⚠️</div>
                      <div>
                        <p className="text-sm font-bold text-red-200">Request Denied</p>
                        <p className="text-xs text-red-300/80 mt-1">The host of this meeting has denied your join request.</p>
                      </div>
                      <button
                        onClick={() => setKnockingState('idle')}
                        className="bg-red-500 hover:bg-red-600 text-white text-xs font-semibold py-1.5 px-4 rounded-lg transition-all duration-300 transform active:scale-95"
                      >
                        Ask Again
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ACTIVE CALL SCREEN RENDER
  return (
    <div className="min-h-screen bg-dark-bg text-white flex flex-col relative overflow-hidden">
      {/* Knocking Request Popup Notification for Host */}
      {isHost && knockingRequests.length > 0 && (
        <div className="fixed top-6 right-6 z-50 w-80 bg-dark-card/95 border border-indigo-500/30 backdrop-blur-xl rounded-2xl p-4 shadow-[0_10px_30px_rgba(99,102,241,0.2)] animate-pulse">
          <div className="flex items-start space-x-3">
            <div className="bg-indigo-600/10 border border-indigo-500/20 text-indigo-400 p-2 rounded-xl">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-gray-400 font-semibold uppercase">Join Request</p>
              <p className="text-sm font-bold text-white mt-0.5 truncate">
                {knockingRequests[0].name}
              </p>
              <p className="text-xs text-gray-400 mt-0.5">wants to join this call</p>
            </div>
          </div>
          <div className="flex space-x-3 mt-4">
            <button
              onClick={() => handleDeny(knockingRequests[0].requesterSocketId)}
              className="flex-1 bg-red-950/20 hover:bg-red-600 border border-red-500/30 text-red-400 hover:text-white py-2 rounded-xl text-xs font-semibold transition-all duration-300 transform active:scale-95 animate-pulse"
            >
              Deny
            </button>
            <button
              onClick={() => handleAdmit(knockingRequests[0].requesterSocketId)}
              className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white py-2 rounded-xl text-xs font-semibold shadow-lg shadow-indigo-600/35 transition-all duration-300 transform active:scale-95"
            >
              Admit
            </button>
          </div>
        </div>
      )}
      {/* 1. Main Call Screen */}
      <div className="flex-grow w-full flex relative overflow-hidden">
        {remoteAudioBlocked && (
          <button
            onClick={enableRemoteAudio}
            className="absolute top-4 left-1/2 -translate-x-1/2 z-40 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold px-4 py-2 rounded-lg shadow-lg transition-colors"
          >
            Enable audio
          </button>
        )}
        
        {/* Dynamic Video Grid Area */}
        <div className="flex-grow flex items-center justify-center p-6 pb-24 overflow-y-auto">
          <div className={`grid gap-4 w-full justify-center items-center ${getGridClasses(peers.length)}`}>
            
            {/* Self Video Box */}
            <div className={`aspect-video bg-dark-card border rounded-2xl overflow-hidden shadow-xl relative flex items-center justify-center transition-all duration-300 ${activeSpeakers.has('local') ? 'border-green-500 ring-4 ring-green-500/40 shadow-[0_0_20px_rgba(34,197,94,0.4)] scale-[1.02]' : 'border-dark-border'}`}>
              {cameraOn ? (
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className={`w-full h-full object-cover ${isScreenSharing ? '' : 'scale-x-[-1]'}`}
                />
              ) : (
                <div className="w-20 h-20 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 text-2xl font-bold uppercase">
                  {displayName?.slice(0, 2) || 'G'}
                </div>
              )}

              {/* Status Badges */}
              <div className="absolute top-4 left-4 bg-black/60 backdrop-blur-md border border-white/5 px-3 py-1 rounded-md text-xs font-semibold">
                You {isScreenSharing ? '(Sharing Screen)' : ''}
              </div>

              <div className="absolute bottom-4 right-4 flex items-center space-x-2">
                {!micOn && (
                  <div className="p-1.5 bg-red-500 text-white rounded-md shadow-md" title="Muted">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                  </div>
                )}
                {handRaised && (
                  <div className="p-1 bg-yellow-500 text-black font-bold rounded-md animate-bounce text-sm shadow-md" title="Hand Raised">
                    ✋
                  </div>
                )}
              </div>
            </div>

            {/* Remote Peer Video Boxes */}
            {peers.map((peer) => (
              <div key={peer.socketId} className={`aspect-video bg-dark-card border rounded-2xl overflow-hidden shadow-xl relative flex items-center justify-center transition-all duration-300 ${activeSpeakers.has(peer.socketId) ? 'border-green-500 ring-4 ring-green-500/40 shadow-[0_0_20px_rgba(34,197,94,0.4)] scale-[1.02]' : 'border-dark-border'}`}>
                
                {/* Dedicated invisible audio player that is ALWAYS active and unmuted to play voice cleanly (explicitly bypassing browser suspensions) */}
                {peer.stream && (
                  <audio
                    data-remote-audio="true"
                    ref={(el) => {
                      if (!el || !peer.stream) return;

                      attachMediaStream(el, peer.stream, true);

                      el.muted = false;
                      el.volume = 1;
                    }}
                    autoPlay
                    playsInline
                  />
                )}

                {/* Video player for peer webcam (muted to prevent duplicate playback conflicts) */}
                {peer.stream && !peer.isCameraOff && (
                  <video
                    ref={(el) => {
                      if (!el || !peer.stream) return;

                      attachMediaStream(el, peer.stream, false);
                    }}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-cover"
                  />
                )}

                {/* Show avatar fallback overlay when camera is off */}
                {peer.isCameraOff && (
                  <div className="w-20 h-20 rounded-full bg-purple-600/20 border border-purple-500/30 flex items-center justify-center text-purple-400 text-2xl font-bold uppercase">
                    {peer.name?.slice(0, 2)}
                  </div>
                )}

                {/* Status Badges */}
                <div className="absolute top-4 left-4 bg-black/60 backdrop-blur-md border border-white/5 px-3 py-1 rounded-md text-xs font-semibold">
                  {peer.name}
                </div>

                <div className="absolute bottom-4 right-4 flex items-center space-x-2">
                  {peer.isMuted && (
                    <div className="p-1.5 bg-red-500 text-white rounded-md shadow-md">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                      </svg>
                    </div>
                  )}
                  {peer.isHandRaised && (
                    <div className="p-1 bg-yellow-500 text-black font-bold rounded-md animate-bounce text-sm shadow-md">
                      ✋
                    </div>
                  )}
                </div>
              </div>
            ))}

          </div>
        </div>

        {/* 2. Side Panel Drawers (Chat / Participants) */}
        {activeDrawer && (
          <div className="w-80 border-l border-dark-border bg-dark-card flex flex-col h-full pb-20 z-20 absolute right-0 top-0 bottom-0 md:relative">
            <div className="p-4 border-b border-dark-border flex items-center justify-between">
              <h3 className="font-bold text-lg">
                {activeDrawer === 'chat' ? 'In-Call Chat' : 'Participants'}
              </h3>
              <button
                onClick={() => setActiveDrawer(null)}
                className="p-1.5 hover:bg-dark-hover rounded-lg text-gray-400 hover:text-white transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Chat Drawer content */}
            {activeDrawer === 'chat' && (
              <div className="flex-grow flex flex-col min-h-0">
                <div className="flex-grow p-4 space-y-4 overflow-y-auto min-h-0">
                  {chatMessages.map((msg, index) => (
                    <div key={msg.id || index} className="space-y-1">
                      <div className="flex items-baseline space-x-2">
                        <span className="text-sm font-bold text-indigo-400">{msg.senderName}</span>
                        <span className="text-[10px] text-gray-500">
                          {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <p className="text-sm text-gray-200 bg-[#08080C] p-2.5 rounded-lg border border-dark-border inline-block break-words max-w-full">
                        {msg.content}
                      </p>
                    </div>
                  ))}
                </div>

                <form onSubmit={handleSendMessage} className="p-4 border-t border-dark-border bg-dark-card flex items-center space-x-2">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Send a message..."
                    className="flex-grow bg-[#08080C] border border-dark-border focus:border-indigo-500 rounded-lg py-2 px-3 text-white text-sm outline-none transition-all focus:ring-1 focus:ring-indigo-500"
                  />
                  <button
                    type="submit"
                    className="p-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors flex items-center justify-center"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                    </svg>
                  </button>
                </form>
              </div>
            )}

            {/* Participants list drawer */}
            {activeDrawer === 'participants' && (
              <div className="flex-grow p-4 overflow-y-auto space-y-4">
                {/* Self list item */}
                <div className="flex items-center justify-between bg-[#08080C] border border-dark-border rounded-xl p-3">
                  <div className="flex items-center space-x-3">
                    <div className="w-8 h-8 rounded bg-indigo-600 flex items-center justify-center font-bold text-xs uppercase text-white">
                      {displayName?.slice(0, 2) || 'G'}
                    </div>
                    <div>
                      <p className="text-sm font-semibold">{displayName || 'Guest'} (You)</p>
                      <p className="text-[10px] text-indigo-400 font-semibold uppercase">HOST</p>
                    </div>
                  </div>
                  <div className="flex space-x-2">
                    {handRaised && <span className="text-sm">✋</span>}
                    {!micOn && <span className="text-sm">🔇</span>}
                  </div>
                </div>

                {/* Peer list items */}
                {peers.map((peer) => (
                  <div key={peer.socketId} className="flex items-center justify-between bg-[#08080C] border border-dark-border rounded-xl p-3">
                    <div className="flex items-center space-x-3">
                      <div className="w-8 h-8 rounded bg-purple-600 flex items-center justify-center font-bold text-xs uppercase text-white">
                        {peer.name?.slice(0, 2)}
                      </div>
                      <div>
                        <p className="text-sm font-semibold">{peer.name}</p>
                        <p className="text-[10px] text-gray-500 uppercase">Participant</p>
                      </div>
                    </div>
                    <div className="flex space-x-2">
                      {peer.isHandRaised && <span className="text-sm">✋</span>}
                      {peer.isMuted && <span className="text-sm">🔇</span>}
                      {peer.isCameraOff && <span className="text-sm">📷 Off</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      </div>

      {/* 3. Bottom Control Navigation Bar */}
      <div className="absolute bottom-0 left-0 right-0 h-20 bg-dark-card border-t border-dark-border flex items-center justify-between px-6 z-30">
        {/* Left: Meeting code identifier */}
        <div className="hidden sm:flex items-center space-x-3">
          <span className="text-sm font-semibold tracking-wider font-mono text-gray-400 bg-[#08080C] border border-dark-border px-3 py-1.5 rounded-lg select-all">
            {roomId}
          </span>
        </div>

        {/* Center: WebRTC controls */}
        <div className="flex items-center space-x-4 mx-auto sm:mx-0">
          {/* Mute toggle button */}
          <button
            onClick={handleToggleMic}
            className={`p-3.5 rounded-full transition-all duration-300 transform hover:scale-105 active:scale-95 ${micOn ? 'bg-dark-border hover:bg-dark-hover text-white' : 'bg-red-500 text-white shadow-lg shadow-red-500/20'}`}
            title={micOn ? 'Mute Microphone' : 'Unmute Microphone'}
          >
            {micOn ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M3 3l18 18M9 5a3 3 0 016 0v5a3 3 0 01-.124.845m-2.146 2.146A3 3 0 019 10v-1m9 2a7 7 0 01-11 5.83M12 18v4m0 0H8m4 0h4" />
              </svg>
            )}
          </button>

          {/* Camera toggle button */}
          <button
            onClick={handleToggleCamera}
            className={`p-3.5 rounded-full transition-all duration-300 transform hover:scale-105 active:scale-95 ${cameraOn ? 'bg-dark-border hover:bg-dark-hover text-white' : 'bg-red-500 text-white shadow-lg shadow-red-500/20'}`}
            title={cameraOn ? 'Turn Off Camera' : 'Turn On Camera'}
          >
            {cameraOn ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.25 2.25l19.5 19.5m-5.467-5.467L15 14m-3.5-3.5L3.75 3.75m12 6.553L21 8.618v6.764a1 1 0 01-.447.894l-2.053 1.026M15 14H5a2 2 0 00-2 2v2a2 2 0 002 2h8a2 2 0 002-2v-2c0-.528-.206-1.008-.541-1.364" />
              </svg>
            )}
          </button>

          {/* Screen Share button disabled/removed as requested */}

          {/* Hand Raise toggle button */}
          <button
            onClick={handleToggleHand}
            className={`p-3.5 rounded-full transition-all duration-300 transform hover:scale-105 active:scale-95 ${handRaised ? 'bg-yellow-500 text-black shadow-lg shadow-yellow-500/30' : 'bg-dark-border hover:bg-dark-hover text-white'}`}
            title="Raise / Lower Hand"
          >
            <span className="text-lg leading-none font-bold">✋</span>
          </button>

          {/* End Call button */}
          <button
            onClick={handleLeaveMeeting}
            className="p-3.5 bg-red-600 hover:bg-red-500 text-white rounded-full transition-all duration-300 shadow-lg shadow-red-600/35 transform hover:scale-105 active:scale-95"
            title="Leave Meeting"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 17l5-5m0 0l-5-5m5 5H9a3 3 0 00-3 3v1a3 3 0 003 3h1" />
            </svg>
          </button>
        </div>

        {/* Right: Drawer slide triggers */}
        <div className="hidden sm:flex items-center space-x-3">
          <button
            onClick={() => setActiveDrawer(activeDrawer === 'participants' ? null : 'participants')}
            className={`p-2.5 rounded-lg border transition-all duration-300 ${activeDrawer === 'participants' ? 'bg-indigo-600/20 border-indigo-500/40 text-indigo-400' : 'bg-[#08080C] border-dark-border text-gray-400 hover:text-white'}`}
            title="Show Participants"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          </button>

          <button
            onClick={() => setActiveDrawer(activeDrawer === 'chat' ? null : 'chat')}
            className={`p-2.5 rounded-lg border transition-all duration-300 relative ${activeDrawer === 'chat' ? 'bg-indigo-600/20 border-indigo-500/40 text-indigo-400' : 'bg-[#08080C] border-dark-border text-gray-400 hover:text-white'}`}
            title="Show Chat"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            {unreadMessages > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white text-[10px] font-bold h-5 w-5 rounded-full flex items-center justify-center border border-dark-bg">
                {unreadMessages}
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default MeetingRoom;
