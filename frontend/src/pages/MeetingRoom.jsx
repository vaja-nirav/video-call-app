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
  const { user } = useSelector((state) => state.auth);

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

  const activeDrawerRef = useRef(null);

  // Sync activeDrawerRef with activeDrawer state & reset unread count when chat is opened
  useEffect(() => {
    activeDrawerRef.current = activeDrawer;
    if (activeDrawer === 'chat') {
      setUnreadMessages(0);
    }
  }, [activeDrawer]);
  
  // Dynamic WebRTC states
  const [peers, setPeers] = useState([]); // List of { socketId, name, stream, isMuted, isCameraOff, isHandRaised }

  // WhatsApp PIP view states
  const [fullscreenSocketId, setFullscreenSocketId] = useState('local');

  // Swipe to next user status states
  const [activeRoomId, setActiveRoomId] = useState(roomId);
  const [isSwitching, setIsSwitching] = useState(false);
  const isSwitchingRef = useRef(false);
  const wheelAccumulator = useRef(0);
  const wheelTimeout = useRef(null);

  useEffect(() => {
    isSwitchingRef.current = isSwitching;
  }, [isSwitching]);

  useEffect(() => {
    setActiveRoomId(roomId);
  }, [roomId]);

  // Handle desktop scroll / wheel down/right to swipe next
  const handleWheel = (e) => {
    if (isSwitchingRef.current || !joined) return;

    // Accumulate maximum absolute displacement from both horizontal and vertical axes for maximum device support
    wheelAccumulator.current += Math.max(Math.abs(e.deltaX), Math.abs(e.deltaY));

    if (wheelTimeout.current) clearTimeout(wheelTimeout.current);

    wheelTimeout.current = setTimeout(() => {
      wheelAccumulator.current = 0;
    }, 200);

    // Trigger if cumulative scroll is strong (displacement > 30)
    if (wheelAccumulator.current > 30) {
      wheelAccumulator.current = 0;
      if (wheelTimeout.current) clearTimeout(wheelTimeout.current);
      triggerNextUser();
    }
  };

  // Handle mobile / tablet touch gesture swipe left or right to trigger next user
  const touchStartX = useRef(0);
  
  const handleTouchStart = (e) => {
    if (isSwitchingRef.current || !joined) return;
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e) => {
    if (isSwitchingRef.current || !joined) return;
    const touchEndX = e.changedTouches[0].clientX;
    const diffX = touchStartX.current - touchEndX;
    
    // Support horizontal skips with a light 50px threshold (left/right swipe)
    if (Math.abs(diffX) > 50) {
      triggerNextUser();
    }
  };

  const triggerNextUser = () => {
    if (isSwitchingRef.current || !socketRef.current) return;
    
    console.log('Skipping current match...');
    isSwitchingRef.current = true;
    setIsSwitching(true);

    // Retrieve previous partner's details first
    const partnerUserId = peers[0]?.userId || null;
    const partnerSocketId = peers[0]?.socketId || null;
    
    // Close existing WebRTC peer connections cleanly
    peerConnectionsRef.current.forEach((pc) => {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
    });
    peerConnectionsRef.current.clear();
    
    // Clear other peers stream and chat messages state
    setPeers([]);
    setUnreadMessages(0);
    setChatMessages([]);
    
    // Emit NEXT_USER_REQUEST to server with payload matching STEP 2
    socketRef.current.emit('next-user-request', {
      currentUserId: user ? user.id : null,
      previousUserId: partnerUserId,
      currentSocketId: socketRef.current.id,
      previousSocketId: partnerSocketId,
    });
  };

  const handlePartnerDisconnected = () => {
    if (isSwitchingRef.current) return;
    
    console.log('Partner disconnected. Auto-searching next user...');
    setIsSwitching(true);

    // Close existing WebRTC peer connections cleanly
    peerConnectionsRef.current.forEach((pc) => {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
    });
    peerConnectionsRef.current.clear();
    
    // Clear other peers stream and chat messages state
    setPeers([]);
    setUnreadMessages(0);
    setChatMessages([]);
  };

  // Handle double-clicking a video card to swap fullscreen / PIP view
  const handleCardDoubleClick = (clickedSocketId) => {
    if (clickedSocketId !== fullscreenSocketId) {
      setFullscreenSocketId(clickedSocketId);
    } else {
      // If we double-click the fullscreen card, swap it back to the first available peer (or local if none)
      if (clickedSocketId === 'local' && peers.length > 0) {
        setFullscreenSocketId(peers[0].socketId);
      } else {
        setFullscreenSocketId('local');
      }
    }
  };

  // Automatically focus the first remote peer when they join, and default back to local if they leave
  useEffect(() => {
    if (peers.length > 0) {
      if (fullscreenSocketId === 'local' || !peers.some(p => p.socketId === fullscreenSocketId)) {
        setFullscreenSocketId(peers[0].socketId);
      }
    } else {
      setFullscreenSocketId('local');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peers]);

  // Automatically sync local stream to the local video element whenever it mounts or updates
  useEffect(() => {
    if (localVideoRef.current) {
      const activeStream = isScreenSharing ? screenStreamRef.current : localStreamRef.current;
      if (activeStream && localVideoRef.current.srcObject !== activeStream) {
        localVideoRef.current.srcObject = activeStream;
      }
    }
  }, [cameraOn, isScreenSharing, joined]);

  // Automatically scroll in-call chat to the bottom when new messages arrive or drawer opens
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, activeDrawer]);

  // Refs for tracking streams and socket connections across renders
  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const peerConnectionsRef = useRef(new Map()); // socketId => RTCPeerConnection
  const localVideoRef = useRef(null);
  const messagesEndRef = useRef(null);
  const joinedRef = useRef(false);
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
    let active = true;

    const setupLobby = async () => {
      let stream = null;
      let audioSupported = true;
      let videoSupported = true;

      if (localStreamRef.current) {
        console.log('Reusing existing local media stream');
        stream = localStreamRef.current;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
      } else {
        // Try requesting both Audio and Video first (Laptop default)
        try {
          stream = await navigator.mediaDevices.getUserMedia({
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
        } catch (err) {
          if (!active) return;
          console.warn('PC lacks either a camera or mic. Attempting fallback modes...', err);

          // Fallback 1: Try Audio-Only (very common for desktop PCs with mic/headset but no webcam)
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
              video: false,
            });
            videoSupported = false;
            setCameraOn(false); // Dynamically toggle camera off in UI
          } catch (audioErr) {
            if (!active) return;
            console.warn('Audio-only failed. Attempting Video-Only...', audioErr);

            // Fallback 2: Try Video-Only (webcam with no microphone)
            try {
              stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                  width: { ideal: 1280 },
                  height: { ideal: 720 },
                  facingMode: 'user',
                },
              });
              audioSupported = false;
              setMicOn(false); // Dynamically mute in UI
            } catch (videoErr) {
              if (!active) return;
              console.error('All media acquisition failed:', videoErr);
              audioSupported = false;
              videoSupported = false;
              alert('No camera or microphone detected. You will join the meeting as a viewer/chatter only!');
            }
          }
        }
      }

      if (!active) {
        if (stream) {
          stream.getTracks().forEach((track) => track.stop());
        }
        return;
      }

      if (stream) {
        localStreamRef.current = stream;
        if (localVideoRef.current && videoSupported) {
          localVideoRef.current.srcObject = stream;
        }

        // Start voice detection for the local user if audio is available
        if (audioSupported && stream.getAudioTracks().length > 0) {
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
        }
      }

      // ALWAYS bypass lobby preview page for both hosts and guests (even without camera/mic stream!)
      if (roomId) {
        let nameToUse = displayName;
        if (!nameToUse && user && user.name) {
          nameToUse = user.name;
        }
        if (!nameToUse) {
          nameToUse = localStorage.getItem('meetsync_name') || 'Stranger';
        }

        localStorage.setItem('meetsync_name', nameToUse);
        console.log(`Direct Connect: bypassing lobby for room ${roomId} as ${nameToUse}`);

        setTimeout(() => {
          if (active) {
            if (isHost || roomId.startsWith('match-')) {
              handleJoinNow(null, nameToUse);
            } else {
              setDisplayName(nameToUse);
              handleAskToJoin(nameToUse);
            }
          }
        }, 250);
      }
    };
    setupLobby();

    return () => {
      active = false;
      // ONLY clean up streams if we are fully leaving the call room dashboard,
      // NOT if we are simply auto-matching / transition-switching to the next user!
      if (!isSwitchingRef.current) {
        cleanUpStreams();
      }
      disconnectSocket();
    };
  }, [roomId]);

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
  const handleAskToJoin = (customName = null) => {
    const nameToUse = customName || displayName;
    if (!nameToUse.trim()) {
      alert('Please enter your display name before asking to join.');
      return;
    }
    setKnockingState('knocking');

    const backendUrl = import.meta.env.VITE_API_URL || '';
    const socket = io(backendUrl, {
      extraHeaders: {
        'ngrok-skip-browser-warning': 'true',
      },
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('ask-to-join', { roomId, name: nameToUse.trim() });
    });

    socket.on('admission-granted', () => {
      console.log('Admission granted by the host!');
      setKnockingState('admitted');
      handleJoinNow(socket, nameToUse); // Join room using the already connected socket!
    });

    socket.on('admission-denied', () => {
      console.log('Admission denied by the host.');
      setKnockingState('denied');
      socket.disconnect();
      socketRef.current = null;
    });
  };

  // 2. Joining the Video Call Room
  const handleJoinNow = async (existingSocket = null, customName = null) => {
    if (joinedRef.current) {
      console.log('Skipping duplicate join room request');
      return;
    }
    joinedRef.current = true;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;

    if (AudioCtx) {
      const ctx = new AudioCtx();
      await ctx.resume();
    }

    const nameToUse = customName || displayName;
    if (!nameToUse.trim()) {
      joinedRef.current = false;
      alert('Please enter your display name before joining.');
      return;
    }
    if (customName) {
      setDisplayName(customName);
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
      socketRef.current = io(backendUrl, {
        extraHeaders: {
          'ngrok-skip-browser-warning': 'true',
        },
      });
    }

    const socket = socketRef.current;

    // Join room packet
    socket.emit('join-room', {
      roomId: activeRoomId,
      userId: user ? user.id : null,
      name: nameToUse.trim(),
      isMuted: !micOn,
      isCameraOff: !cameraOn,
      isHandRaised: handRaised,
    });

    // Clean any existing listeners to prevent duplicate event triggers (Strict Mode / React 18 friendly)
    socket.off('knocking-request');
    socket.off('users-in-room');
    socket.off('user-joined');
    socket.off('webrtc-offer');
    socket.off('webrtc-answer');
    socket.off('webrtc-ice-candidate');
    socket.off('peer-toggle-mute');
    socket.off('peer-toggle-camera');
    socket.off('peer-raise-hand');
    socket.off('message');
    socket.off('user-left');

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
        userId: peer.userId,
        name: peer.name,
        stream: null,
        isMuted: peer.isMuted ?? false,
        isCameraOff: peer.isCameraOff ?? false,
        isHandRaised: peer.isHandRaised ?? false,
      })));

      peersList.forEach((peer) => {
        // Create an RTC connection pointing to this peer
        const pc = createPeerConnection(peer.socketId, peer.name);
        
        // Create offer if we are the newcomer (mesh initiator)
        initiateCall(peer.socketId, pc);
      });
    });

    // Event: New user joined
    socket.on('user-joined', ({ socketId, userId, name, isMuted, isCameraOff, isHandRaised }) => {
      console.log(`User joined: ${name} (${socketId})`);
      // Add them to the peers UI immediately
      setPeers((prev) => {
        if (prev.find((p) => p.socketId === socketId)) return prev;
        return [...prev, { socketId, userId, name, stream: null, isMuted: isMuted ?? false, isCameraOff: isCameraOff ?? false, isHandRaised: isHandRaised ?? false }];
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
      
      // Only increment unread badge if the message came from someone else and chat drawer is closed
      const isMyMessage = message.senderName === displayName || 
                          (user && message.userId === user.id);
      
      if (!isMyMessage && activeDrawerRef.current !== 'chat') {
        setUnreadMessages((prevUnread) => prevUnread + 1);
      }
    });

    // Event: Match disconnected (partner swiped away)
    socket.on('match-disconnected', () => {
      console.log('Match disconnected by partner. Redirecting to home...');
      // Flag so Home page knows NOT to auto-match this user on arrival —
      // they were kicked, not voluntarily searching.
      localStorage.setItem('meetsync_was_kicked', '1');
      handleLeaveMeeting();
    });

    // Event: MATCH_FOUND (found next user!)
    socket.on('MATCH_FOUND', ({ roomId: newRoomId, partnerName, partnerUserId }) => {
      console.log(`MATCH_FOUND received! New room: ${newRoomId}, partner: ${partnerName}`);
      
      // Lock switching state to prevent unmount triggers
      isSwitchingRef.current = true;
      setIsSwitching(true);

      // Keep showing the transition screen briefly, then redirect cleanly to the new room ID
      setTimeout(() => {
        window.location.href = `/room/${newRoomId}`;
      }, 800);
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

      setPeers((prev) => {
        const remaining = prev.filter((p) => p.socketId !== socketId);
        if (remaining.length === 0) {
          console.log('Call partner disconnected.');
          if (isSwitchingRef.current) {
            console.log('We are actively switching/searching, ignoring partner departure.');
          } else {
            console.log('Partner left, leaving to home page...');
            setTimeout(() => {
              handleLeaveMeeting();
            }, 800);
          }
        }
        return remaining;
      });
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
    localStorage.setItem('meetsync_just_left_call', 'true');
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

  // Dynamic Grid Layout Helper removed (migrated to WhatsApp picture-in-picture layout)

  // LOBBY PREVIEW SCREEN RENDER (Only shown as fullscreen status for guests)
  if (!joined) {
    if (knockingState === 'knocking') {
      return (
        <div className="min-h-screen bg-dark-bg text-white flex flex-col items-center justify-center p-6 relative overflow-hidden">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-600/10 rounded-full blur-[100px] pointer-events-none"></div>
          <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-600/10 rounded-full blur-[100px] pointer-events-none"></div>
          <div className="w-full max-w-md bg-dark-card border border-indigo-500/20 rounded-3xl p-8 text-center space-y-6 shadow-2xl relative z-10 animate-pulse">
            <div className="relative w-20 h-20 mx-auto flex items-center justify-center">
              <div className="absolute inset-0 rounded-full bg-indigo-500/15 animate-ping"></div>
              <div className="w-14 h-14 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xl font-bold shadow-lg shadow-indigo-600/30">
                <svg className="animate-spin h-6 w-6 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              </div>
            </div>
            <div>
              <h3 className="text-lg font-bold text-white">Asking to join...</h3>
              <p className="text-xs text-indigo-400 mt-1 font-semibold animate-pulse">Please wait for the host to admit you.</p>
            </div>
            <button
              onClick={() => navigate('/')}
              className="w-full bg-dark-bg hover:bg-dark-hover border border-dark-border text-gray-300 font-semibold py-3 rounded-xl transition-all duration-300"
            >
              Cancel Request
            </button>
          </div>
        </div>
      );
    }

    if (knockingState === 'denied') {
      return (
        <div className="min-h-screen bg-dark-bg text-white flex flex-col items-center justify-center p-6 relative overflow-hidden">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-600/10 rounded-full blur-[100px] pointer-events-none"></div>
          <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-600/10 rounded-full blur-[100px] pointer-events-none"></div>
          <div className="w-full max-w-md bg-dark-card border border-red-500/20 rounded-3xl p-8 text-center space-y-6 shadow-2xl relative z-10">
            <div className="w-16 h-16 bg-red-950/40 border border-red-500/30 text-red-500 rounded-full flex items-center justify-center mx-auto text-2xl">
              ⚠️
            </div>
            <div>
              <h3 className="text-lg font-bold text-red-200">Request Denied</h3>
              <p className="text-xs text-red-300/80 mt-1">The host of this meeting has denied your join request.</p>
            </div>
            <button
              onClick={() => navigate('/')}
              className="w-full bg-red-600 hover:bg-red-500 text-white font-semibold py-3 rounded-xl transition-all duration-300 transform active:scale-95"
            >
              Go to Dashboard
            </button>
          </div>
        </div>
      );
    }

    // Default connecting placeholder (shows only briefly while acquiring hardware streams)
    return (
      <div className="min-h-screen bg-dark-bg text-white flex flex-col items-center justify-center p-6 relative overflow-hidden">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-600/10 rounded-full blur-[100px] pointer-events-none"></div>
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-600/10 rounded-full blur-[100px] pointer-events-none"></div>
        <div className="w-full max-w-md bg-dark-card border border-indigo-500/20 rounded-3xl p-8 text-center space-y-6 shadow-2xl relative z-10 animate-pulse">
          <svg className="animate-spin h-8 w-8 text-indigo-500 mx-auto" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p className="text-sm font-bold text-white">Starting Video Call...</p>
        </div>
      </div>
    );
  }

  // Prepare all video stream sources for the call
  const allStreams = [
    {
      socketId: 'local',
      name: displayName || 'You',
      isLocal: true,
      isCameraOff: !cameraOn,
      isMuted: !micOn,
      isHandRaised: handRaised,
      stream: isScreenSharing ? screenStreamRef.current : localStreamRef.current,
      activeSpeakerKey: 'local'
    },
    ...peers.map(peer => ({
      socketId: peer.socketId,
      name: peer.name,
      isLocal: false,
      isCameraOff: peer.isCameraOff,
      isMuted: peer.isMuted,
      isHandRaised: peer.isHandRaised,
      stream: peer.stream,
      activeSpeakerKey: peer.socketId
    }))
  ];

  const fullscreenStream = allStreams.find(item => item.socketId === fullscreenSocketId) || allStreams[0];
  const pipStreams = allStreams.filter(item => item.socketId !== fullscreenStream.socketId);

  // Helper to render video cards (custom WhatsApp layout)
  const renderVideoCard = (item, isPip = false) => {
    const isActiveSpeaker = activeSpeakers.has(item.activeSpeakerKey);
    
    return (
      <div
        key={item.socketId}
        onDoubleClick={() => handleCardDoubleClick(item.socketId)}
        className={isPip 
          ? `w-24 h-36 sm:w-56 sm:h-auto sm:aspect-video bg-dark-card border rounded-xl overflow-hidden shadow-2xl relative flex items-center justify-center cursor-pointer transition-all duration-300 hover:scale-[1.05] active:scale-95 pointer-events-auto z-20 ${isActiveSpeaker ? 'border-green-500 ring-2 ring-green-500/40 shadow-[0_0_15px_rgba(34,197,94,0.4)]' : 'border-dark-border'}`
          : `w-full h-full absolute inset-0 z-0 bg-[#0c0c14] flex items-center justify-center transition-all duration-300 ${isActiveSpeaker ? 'ring-2 ring-green-500/20' : ''}`
        }
      >
        {/* Remote audio tag (only for peers, regardless of whether PIP or fullscreen) */}
        {!item.isLocal && item.stream && (
          <audio
            data-remote-audio="true"
            ref={(el) => {
              if (!el || !item.stream) return;
              attachMediaStream(el, item.stream, true);
              el.muted = false;
              el.volume = 1;
            }}
            autoPlay
            playsInline
          />
        )}

        {/* Video stream rendering */}
        {item.stream && !item.isCameraOff ? (
          <video
            ref={(el) => {
              if (!el) return;
              if (item.isLocal) {
                localVideoRef.current = el;
                const activeStream = isScreenSharing ? screenStreamRef.current : localStreamRef.current;
                if (activeStream && el.srcObject !== activeStream) {
                  el.srcObject = activeStream;
                }
              } else {
                attachMediaStream(el, item.stream, false);
              }
            }}
            autoPlay
            playsInline
            className={`w-full h-full object-cover ${item.isLocal && !isScreenSharing ? 'scale-x-[-1]' : ''}`}
          />
        ) : (
          /* Fallback Avatar */
          <div className={`rounded-full flex items-center justify-center font-bold uppercase transition-all duration-300 ${isPip ? 'w-12 h-12 text-sm bg-indigo-600/20 border border-indigo-500/30 text-indigo-400 font-mono' : 'w-24 h-24 text-4xl bg-indigo-600/10 border border-indigo-500/20 text-indigo-400 font-mono shadow-xl shadow-indigo-600/5'}`}>
            {item.name?.slice(0, 2) || 'G'}
          </div>
        )}

        {/* Status badges overlay */}
        <div className={`absolute bg-black/60 backdrop-blur-md border border-white/5 rounded font-semibold text-gray-200 z-10 flex items-center space-x-1.5 ${isPip ? 'top-1.5 left-1.5 px-1 py-0.5 text-[8px]' : 'top-3 left-3 px-2 py-0.5 text-[10px]'}`}>
          {/* Pulsing Active Speaker dot */}
          {isActiveSpeaker && <span className={`bg-green-500 rounded-full animate-pulse ${isPip ? 'w-1 h-1' : 'w-1.5 h-1.5'}`}></span>}
          <span>
            {isPip 
              ? (item.isLocal ? 'You' : item.name?.split(' ')[0]) 
              : `${item.name}${item.isLocal ? ' (You)' : ''}`
            }
          </span>
          {((!item.isLocal) || (item.isLocal && !isPip)) && item.isHandRaised && (
            <span className="text-xs animate-bounce" title="Hand Raised">✋</span>
          )}
          {((!item.isLocal) || (item.isLocal && !isPip)) && item.isMuted && (
            <span className="text-xs text-red-500" title="Muted">🔇</span>
          )}
        </div>

        {/* Bottom indicators overlay */}
        {item.isLocal && isPip && (item.isMuted || item.isHandRaised) && (
          <div className="absolute bottom-1.5 right-1.5 flex items-center space-x-1 z-10">
            {item.isMuted && (
              <div className="bg-red-500/80 backdrop-blur-sm text-white rounded flex items-center justify-center p-0.5 text-[8px]" title="Muted">
                <svg className="w-2 h-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
              </div>
            )}
            {item.isHandRaised && (
              <div className="bg-yellow-500 text-black font-bold rounded animate-bounce shadow-md flex items-center justify-center p-0.5 text-[10px]" title="Hand Raised">
                ✋
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // ACTIVE CALL SCREEN RENDER
  return (
    <div 
      className="h-screen max-h-screen bg-dark-bg text-white flex flex-col relative overflow-hidden"
    >
      {/* Custom Ultra-Smooth Horizontal Bounce Keyframes */}
      <style>{`
        @keyframes bounce-x {
          0%, 100% { transform: translateX(0); }
          50% { transform: translateX(6px); }
        }
        .animate-bounce-x {
          animation: bounce-x 1.5s infinite ease-in-out;
        }
      `}</style>

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
        
        {/* Dynamic Video Grid Area (WhatsApp PIP layout style) */}
        <div 
          id="video-grid-area"
          className={`flex-grow flex-1 self-stretch relative flex items-center justify-center bg-[#060609] overflow-hidden transform transition-all duration-700 cubic-bezier(0.16, 1, 0.3, 1) ${isSwitching ? '-translate-x-full opacity-0 scale-95' : 'translate-y-0 opacity-100 scale-100'}`}
        >
          {/* 100% Bulletproof Transparent Gesture Shield */}
          <div 
            className="absolute inset-0 z-10 cursor-ew-resize pointer-events-auto bg-transparent"
            onWheel={handleWheel}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            onDoubleClick={() => fullscreenStream && handleCardDoubleClick(fullscreenStream.socketId)}
          />
          
          {/* 1. Fullscreen Main Video */}
          {fullscreenStream && renderVideoCard(fullscreenStream, false)}
          
          {/* 2. Floating Small PIP Cards (WhatsApp Style) */}
          {pipStreams.length > 0 && (
            <div className="absolute bottom-24 right-3 sm:right-6 z-20 flex flex-col-reverse gap-3 pointer-events-none">
              {pipStreams.map(item => renderVideoCard(item, true))}
            </div>
          )}

          {/* 3. Floating Horizontal Premium Bouncing Skip Arrow (Clickable and Visually Pulsing on mobile and desktop) */}
          {!isSwitching && !activeDrawer && (
            <button
              onClick={triggerNextUser}
              className="absolute right-3 sm:right-6 top-1/2 -translate-y-1/2 z-30 w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-indigo-600 hover:bg-indigo-500 border border-indigo-400/30 text-white flex flex-col items-center justify-center shadow-[0_0_15px_rgba(99,102,241,0.4)] hover:shadow-[0_0_25px_rgba(99,102,241,0.6)] transition-all duration-300 active:scale-95 group cursor-pointer"
              title="Swipe/Click to Connect with Next User"
            >
              <svg className="w-5 h-5 text-white animate-bounce-x" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
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
                <div className="flex-grow p-4 space-y-4 overflow-y-auto min-h-0 bg-[#07070a]">
                  {chatMessages.map((msg, index) => {
                    const isMyMessage = msg.senderName === displayName || 
                                        msg.senderName === 'You' || 
                                        (user && msg.userId === user.id);
                    
                    return (
                      <div 
                        key={msg.id || index} 
                        className={`flex flex-col ${isMyMessage ? 'items-end' : 'items-start'} space-y-1 w-full`}
                      >
                        {/* Sender details and time */}
                        <div className="flex items-center space-x-2 px-1 text-[10px] text-gray-400">
                          {!isMyMessage && (
                            <span className="font-bold text-indigo-400">{msg.senderName}</span>
                          )}
                          <span>
                            {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>

                        {/* Chat bubble */}
                        <div 
                          className={`text-sm p-3 rounded-2xl max-w-[85%] break-words shadow-lg border transition-all duration-300 ${
                            isMyMessage 
                              ? 'bg-emerald-600/15 border-emerald-500/20 text-emerald-100 rounded-tr-sm shadow-emerald-950/10' 
                              : 'bg-dark-card border-dark-border text-gray-200 rounded-tl-sm'
                          }`}
                        >
                          <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={messagesEndRef} />
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
      <div className="absolute bottom-0 left-0 right-0 h-20 bg-dark-card border-t border-dark-border flex items-center justify-between px-3 sm:px-6 z-30">

        {/* Center: WebRTC controls */}
        <div className="flex items-center space-x-2 sm:space-x-4 mx-auto sm:mx-0">
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
        <div className="flex items-center space-x-2 sm:space-x-3">
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

      {/* Premium TikTok-style Swipe-to-Next Loading Overlay */}
      {isSwitching && (
        <div className="absolute inset-0 bg-[#060609]/80 backdrop-blur-xl z-40 flex flex-col items-center justify-center animate-fade-in">
          <div className="relative flex flex-col items-center space-y-6">
            {/* Animated Pulsing Radar Rings */}
            <div className="relative w-28 h-28 flex items-center justify-center">
              <div className="absolute inset-0 rounded-full bg-indigo-500/10 border border-indigo-500/20 animate-ping" style={{ animationDuration: '3s' }}></div>
              <div className="absolute inset-2 rounded-full bg-indigo-500/20 border border-indigo-500/30 animate-ping" style={{ animationDuration: '2s' }}></div>
              <div className="absolute inset-4 rounded-full bg-indigo-500/35 border border-indigo-500/40 animate-ping" style={{ animationDuration: '1.5s' }}></div>
              
              {/* Center Icon */}
              <div className="w-16 h-16 rounded-full bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/30">
                <svg className="w-8 h-8 text-white animate-spin" style={{ animationDuration: '2s' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 7.89M9 11l3 3L22 4" />
                </svg>
              </div>
            </div>
            
            {/* Status Text */}
            <div className="text-center space-y-2 flex flex-col items-center">
              <h3 className="text-xl font-bold tracking-wider text-white uppercase bg-clip-text text-transparent bg-gradient-to-r from-indigo-200 via-white to-purple-200">
                Finding next user...
              </h3>
              <p className="text-xs text-indigo-400 font-semibold tracking-widest uppercase animate-pulse">
                Connecting you to someone new...
              </p>

              {/* Go to Home Page Button */}
              <button
                onClick={handleLeaveMeeting}
                className="mt-6 px-6 py-2.5 bg-white/10 hover:bg-white/15 text-white border border-white/20 hover:border-white/30 rounded-xl font-medium text-sm transition-all duration-300 backdrop-blur-md flex items-center space-x-2 transform hover:scale-105 active:scale-95 shadow-lg shadow-black/20"
              >
                <svg className="w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                </svg>
                <span>Go to Home Page</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MeetingRoom;
