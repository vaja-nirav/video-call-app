import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { MeetingsService } from './meetings.service';

@WebSocketGateway({
  cors: {
    origin: '*', // Allow all cross-origins for seamless web socket connections
  },
})
export class MeetingsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  // In-memory registry mapping Socket ID to participant session details
  // Format: socket.id => { roomId, userId, name, participantId, isMuted, isCameraOff, isHandRaised }
  private socketRegistry = new Map<
    string,
    {
      roomId: string;
      userId: number | null;
      name: string;
      participantId: number;
      isMuted: boolean;
      isCameraOff: boolean;
      isHandRaised: boolean;
    }
  >();
  
  // Real-time active presence registry for online users & vertical scroll matchmaking
  // Format: socketId => { socketId, userId, name, autoMatchEnabled, isBusy, status }
  private activePresence = new Map<
    string,
    {
      socketId: string;
      userId: number | null;
      name: string;
      autoMatchEnabled: boolean;
      isBusy: boolean;
      status?: 'FREE' | 'BUSY' | 'SEARCHING';
    }
  >();

  // Tracks matchmaking history of who met whom so they are not automatically matched again
  // Format: key => Set of keys they have already matched with
  private matchedHistory = new Map<string | number, Set<string | number>>();
  
  // Tracks only the immediate swiped partner ID to prevent immediate re-matching
  // Format: key (userId or socketId) => partnerKey (userId or socketId)
  private immediateSwipedPartner = new Map<string | number, string | number>();

  constructor(private meetingsService: MeetingsService) {
    setInterval(() => {
      this.processSearchingMatchmaking();
    }, 2000);
  }

  handleConnection(client: Socket) {
    console.log(`Socket Client Connected: ${client.id}`);
  }

  async handleDisconnect(client: Socket) {
    console.log(`Socket Client Disconnected: ${client.id}`);

    // Remove from active presence — but only if they are BUSY or SEARCHING.
    // If they are FREE, it means they were swiped and their presence was already
    // updated to FREE for instant matching; the new socket from Home will overwrite it.
    if (this.activePresence.has(client.id)) {
      const presence = this.activePresence.get(client.id);
      // Always remove — new socket from Home dashboard will re-register them
      this.activePresence.delete(client.id);
      console.log(`Presence removed for disconnected socket: ${client.id} (was ${presence?.status})`);
      this.broadcastOnlineUsers();
    }

    const session = this.socketRegistry.get(client.id);
    
    if (session) {
      const { roomId, userId, name, participantId } = session;

      // If it is an active matchmaking room, find the other participant in this room
      // and register an immediate swiped partner protection so they do not instantly re-match each other on dashboard
      if (roomId && roomId.startsWith('match-')) {
        const otherParticipant = Array.from(this.socketRegistry.entries())
          .find(([sid, s]) => s.roomId === roomId && sid !== client.id);
        if (otherParticipant && userId && otherParticipant[1].userId) {
          const idSelf = Number(userId);
          const idPartner = Number(otherParticipant[1].userId);
          this.immediateSwipedPartner.set(idSelf, idPartner);
          this.immediateSwipedPartner.set(idPartner, idSelf);
          console.log(`End Call cooldown registered: User ${idSelf} <-> User ${idPartner}`);
        }
      }
      
      // Remove from room in registry
      this.socketRegistry.delete(client.id);

      // Broadcast to other peers in room that user has left
      client.to(roomId).emit('user-left', {
        socketId: client.id,
        userId,
        name,
      });

      // Persist the leaving event to MySQL database via MeetingsService
      try {
        await this.meetingsService.removeParticipant(participantId);
        await this.meetingsService.createCallLog(roomId, userId, 'LEFT', `${name} disconnected from call.`);
      } catch (err) {
        console.error(`Failed to log participant exit in DB for socket ${client.id}:`, err);
      }
    }
  }

  @SubscribeMessage('join-room')
  async handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { roomId: string; userId: number | null; name: string; isMuted?: boolean; isCameraOff?: boolean; isHandRaised?: boolean },
  ) {
    const { roomId, userId, name, isMuted = false, isCameraOff = false, isHandRaised = false } = payload;

    // Fetch existing room peers before joining this socket to the room
    const peersInRoom = Array.from(this.socketRegistry.entries())
      .filter(([_, data]) => data.roomId === roomId)
      .map(([socketId, data]) => ({
        socketId,
        userId: data.userId,
        name: data.name,
        isMuted: data.isMuted,
        isCameraOff: data.isCameraOff,
        isHandRaised: data.isHandRaised,
      }));

    // Register user in the database
    let participantId = 0;
    try {
      const role = peersInRoom.length === 0 ? 'HOST' : 'PARTICIPANT';
      const participant = await this.meetingsService.addParticipant(roomId, userId || undefined, name, role);
      participantId = participant.id;
      await this.meetingsService.createCallLog(roomId, userId, 'JOINED', `${name} joined call as ${role}.`);
    } catch (err) {
      console.error(`DB error during join-room for ${name}:`, err);
    }

    // Register socket details in-memory
    this.socketRegistry.set(client.id, {
      roomId,
      userId,
      name,
      participantId,
      isMuted,
      isCameraOff,
      isHandRaised,
    });

    // Always register presence for any connected socket (logged-in OR guest!)
    if (userId) {
      this.cleanDuplicatePresence(userId, client.id);
    }
    this.activePresence.set(client.id, {
      socketId: client.id,
      userId: userId ? Number(userId) : null,
      name,
      autoMatchEnabled: roomId.startsWith('match-'),
      isBusy: true,
      status: 'BUSY',
    });
    this.broadcastOnlineUsers();

    // Join the client to the socket.io room
    client.join(roomId);

    // 1. Tell the new user about existing participants in the room
    client.emit('users-in-room', peersInRoom);

    // 2. Alert existing users that a new peer has joined
    client.to(roomId).emit('user-joined', {
      socketId: client.id,
      userId,
      name,
      isMuted,
      isCameraOff,
      isHandRaised,
    });
  }

  // Route WebRTC SDP offer from caller to receiver
  @SubscribeMessage('webrtc-offer')
  handleOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { toSocketId: string; offer: any },
  ) {
    this.server.to(payload.toSocketId).emit('webrtc-offer', {
      fromSocketId: client.id,
      offer: payload.offer,
    });
  }

  // Route WebRTC SDP answer back to caller
  @SubscribeMessage('webrtc-answer')
  handleAnswer(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { toSocketId: string; answer: any },
  ) {
    this.server.to(payload.toSocketId).emit('webrtc-answer', {
      fromSocketId: client.id,
      answer: payload.answer,
    });
  }

  // Route WebRTC ICE Candidates to peer
  @SubscribeMessage('webrtc-ice-candidate')
  handleIceCandidate(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { toSocketId: string; candidate: any },
  ) {
    this.server.to(payload.toSocketId).emit('webrtc-ice-candidate', {
      fromSocketId: client.id,
      candidate: payload.candidate,
    });
  }

  // Mute/Unmute microphone updates sync
  @SubscribeMessage('toggle-mute')
  async handleToggleMute(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { isMuted: boolean },
  ) {
    const session = this.socketRegistry.get(client.id);
    if (session) {
      session.isMuted = payload.isMuted; // Update in-memory state

      client.to(session.roomId).emit('peer-toggle-mute', {
        socketId: client.id,
        isMuted: payload.isMuted,
      });

      // Save mic state to DB
      await this.meetingsService.updateParticipantState(session.participantId, {
        isMuted: payload.isMuted,
      });
      await this.meetingsService.createCallLog(
        session.roomId,
        session.userId,
        payload.isMuted ? 'MUTE' : 'UNMUTE',
        `${session.name} ${payload.isMuted ? 'muted' : 'unmuted'} microphone.`,
      );
    }
  }

  // Camera On/Off updates sync
  @SubscribeMessage('toggle-camera')
  async handleToggleCamera(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { isCameraOff: boolean },
  ) {
    const session = this.socketRegistry.get(client.id);
    if (session) {
      session.isCameraOff = payload.isCameraOff; // Update in-memory state

      client.to(session.roomId).emit('peer-toggle-camera', {
        socketId: client.id,
        isCameraOff: payload.isCameraOff,
      });

      // Save camera state to DB
      await this.meetingsService.updateParticipantState(session.participantId, {
        isCameraOff: payload.isCameraOff,
      });
      await this.meetingsService.createCallLog(
        session.roomId,
        session.userId,
        payload.isCameraOff ? 'CAMERA_OFF' : 'CAMERA_ON',
        `${session.name} turned camera ${payload.isCameraOff ? 'off' : 'on'}.`,
      );
    }
  }

  // Hand Raise updates sync
  @SubscribeMessage('raise-hand')
  async handleRaiseHand(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { isHandRaised: boolean },
  ) {
    const session = this.socketRegistry.get(client.id);
    if (session) {
      session.isHandRaised = payload.isHandRaised; // Update in-memory state

      client.to(session.roomId).emit('peer-raise-hand', {
        socketId: client.id,
        isHandRaised: payload.isHandRaised,
      });

      await this.meetingsService.updateParticipantState(session.participantId, {
        isHandRaised: payload.isHandRaised,
      });
      await this.meetingsService.createCallLog(
        session.roomId,
        session.userId,
        payload.isHandRaised ? 'HAND_RAISED' : 'HAND_LOWERED',
        `${session.name} ${payload.isHandRaised ? 'raised' : 'lowered'} their hand.`,
      );
    }
  }

  // Real-time Chat message broadcasting & DB storage
  @SubscribeMessage('send-message')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { content: string },
  ) {
    const session = this.socketRegistry.get(client.id);
    if (session) {
      const { roomId, userId, name } = session;
      let messageId = Math.floor(Math.random() * 1000000);
      let createdAt = new Date();

      try {
        // Persist the message in MySQL
        const message = await this.meetingsService.saveMessage(
          roomId,
          userId,
          name,
          payload.content,
        );
        messageId = message.id;
        createdAt = message.createdAt;
      } catch (err) {
        console.error('Failed to save chat message to DB, falling back to real-time socket transmission:', err);
      }

      // Broadcast message to everyone in room (including sender)
      this.server.to(roomId).emit('message', {
        id: messageId,
        senderName: name,
        userId,
        content: payload.content,
        createdAt,
      });
    }
  }

  @SubscribeMessage('next-user-request')
  async handleNextUserRequest(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { currentUserId: number; previousUserId: number; currentSocketId?: string; previousSocketId?: string },
  ) {
    const currentSocketId = payload.currentSocketId || client.id;
    console.log(`Next User skip request on socket ${currentSocketId}`);

    const session = this.socketRegistry.get(client.id);

    // 1. Mark current socket as SEARCHING
    if (payload.currentUserId) {
      this.cleanDuplicatePresence(Number(payload.currentUserId), currentSocketId);
    }
    const presenceSelf = this.activePresence.get(currentSocketId);
    if (presenceSelf) {
      presenceSelf.isBusy = false;
      presenceSelf.status = 'SEARCHING';
    } else {
      this.activePresence.set(currentSocketId, {
        socketId: currentSocketId,
        userId: Number(payload.currentUserId) || null,
        name: session?.name || 'Stranger',
        autoMatchEnabled: true,
        isBusy: false,
        status: 'SEARCHING',
      });
    }

    // 2. Mark previous partner's socket as FREE (waiting) directly
    let previousSocketId = payload.previousSocketId;
    if (!previousSocketId && payload.previousUserId) {
      const found = Array.from(this.activePresence.entries())
        .find(([_, data]) => data.userId === Number(payload.previousUserId));
      if (found) previousSocketId = found[0];
    }

    if (previousSocketId) {
      const presencePartner = this.activePresence.get(previousSocketId);
      if (presencePartner) {
        // Immediately mark partner as FREE so the matchmaking engine can pair
        // User A (SEARCHING) with User C (FREE) right now — before partner disconnects.
        presencePartner.isBusy = false;
        presencePartner.status = 'FREE';
        presencePartner.autoMatchEnabled = true;
      }
    }

    // 3. Track immediate swiped partner to prevent immediate re-connection
    const idSelf = presenceSelf?.userId || currentSocketId;
    const idPartner = previousSocketId ? (this.activePresence.get(previousSocketId)?.userId || previousSocketId) : null;

    if (idSelf && idPartner) {
      this.immediateSwipedPartner.set(idSelf as any, idPartner as any);
      this.immediateSwipedPartner.set(idPartner as any, idSelf as any);
    }

    // 4. Run matchmaking NOW (partner is FREE in map, User 1 is SEARCHING)
    this.broadcastOnlineUsers();
    this.processSearchingMatchmaking();

    // 5. AFTER match is found and emitted, tell the old partner to go home
    //    Small delay so MATCH_FOUND is sent to User 1 before partner socket closes
    if (previousSocketId) {
      setTimeout(() => {
        this.server.to(previousSocketId).emit('match-disconnected');
      }, 200);
    }

    // 6. Retry loop: if no partner was found immediately (e.g. User 3 is still navigating home
    //    and hasn't re-registered yet), keep retrying every 500ms for up to 10 seconds.
    //    The setInterval already retries every 2s, but this gives faster pickup.
    let retries = 0;
    const retryInterval = setInterval(() => {
      retries++;
      const stillSearching = this.activePresence.get(currentSocketId)?.status === 'SEARCHING';
      if (!stillSearching || retries >= 20) {
        clearInterval(retryInterval);
        return;
      }
      console.log(`Retry matchmaking for ${currentSocketId} (attempt ${retries})`);
      this.processSearchingMatchmaking();
    }, 500);
  }

  private processSearchingMatchmaking() {
    const searching = Array.from(this.activePresence.entries())
      .filter(([_, data]) => data.status === 'SEARCHING')
      .map(([_, data]) => data);

    for (const userA of searching) {
      const partner = Array.from(this.activePresence.entries())
        .map(([_, data]) => data)
        .find((u) => {
          if (u.socketId === userA.socketId) return false;
          // Must be FREE or SEARCHING
          if (u.status !== 'FREE' && u.status !== 'SEARCHING') return false;

          // If they are FREE (on the dashboard), they are eligible to be matched by a searching scroller!
          // (They don't need active autoMatchEnabled = true to be chosen as a partner)

          // Prevent matching immediate swiped partner
          const idSelf = userA.userId || userA.socketId;
          const idPartner = u.userId || u.socketId;
          const swipedPartner = this.immediateSwipedPartner.get(idSelf as any);
          if (swipedPartner && swipedPartner === idPartner) return false;

          // Prevent matching own account in multiple tabs
          if (userA.userId && u.userId && userA.userId === u.userId) return false;

          return true;
        });

      if (partner) {
        const dataA = this.activePresence.get(userA.socketId);
        const dataB = this.activePresence.get(partner.socketId);
        
        const statusA = dataA?.status || 'SEARCHING';
        const statusB = dataB?.status || 'SEARCHING';

        if (dataA) {
          dataA.isBusy = true;
          dataA.status = 'BUSY';
        }
        if (dataB) {
          dataB.isBusy = true;
          dataB.status = 'BUSY';
        }

        const roomCode = `match-${userA.socketId}-${partner.socketId}`;
        console.log(`Searching Matchmaking pairing found: ${userA.name} ↔ ${partner.name}. Room: ${roomCode}`);

        // Emit MATCH_FOUND or auto-match-redirect depending on starting status
        if (statusA === 'SEARCHING') {
          this.server.to(userA.socketId).emit('MATCH_FOUND', { roomId: roomCode, partnerName: partner.name, partnerUserId: partner.userId, partnerSocketId: partner.socketId });
        } else {
          this.server.to(userA.socketId).emit('auto-match-redirect', { roomCode });
        }

        if (statusB === 'SEARCHING') {
          this.server.to(partner.socketId).emit('MATCH_FOUND', { roomId: roomCode, partnerName: userA.name, partnerUserId: userA.userId, partnerSocketId: userA.socketId });
        } else {
          this.server.to(partner.socketId).emit('auto-match-redirect', { roomCode });
        }

        // Broadcast updated online presence list to update dashboard states instantly!
        this.broadcastOnlineUsers();
      }
    }
  }

  // Knocking / Join requests (like Google Meet)
  @SubscribeMessage('ask-to-join')
  async handleAskToJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { roomId: string; name: string },
  ) {
    const { roomId, name } = payload;
    console.log(`User ${name} (${client.id}) is knocking on room ${roomId}`);
    
    // Joint client to a temporary "knocking" channel or broadcast directly to the room
    client.join(`knocking-${roomId}`);
    
    // Broadcast the knock to the meeting host/existing users
    client.to(roomId).emit('knocking-request', {
      requesterSocketId: client.id,
      name,
    });
  }

  @SubscribeMessage('admit-user')
  async handleAdmitUser(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { roomId: string; requesterSocketId: string },
  ) {
    const { roomId, requesterSocketId } = payload;
    console.log(`Host admitted user ${requesterSocketId} to room ${roomId}`);
    
    // Send admission granted event to the guest
    this.server.to(requesterSocketId).emit('admission-granted');
  }

  @SubscribeMessage('deny-user')
  async handleDenyUser(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { roomId: string; requesterSocketId: string },
  ) {
    const { roomId, requesterSocketId } = payload;
    console.log(`Host denied user ${requesterSocketId} for room ${roomId}`);
    
    // Send admission denied event to the guest
    this.server.to(requesterSocketId).emit('admission-denied');
  }

  private cleanDuplicatePresence(userId: number, currentSocketId: string) {
    if (!userId) return;
    const targetUserId = Number(userId);
    for (const [socketId, data] of this.activePresence.entries()) {
      if (data.userId === targetUserId && socketId !== currentSocketId) {
        this.activePresence.delete(socketId);
        console.log(`Cleaned up duplicate stale presence socket ${socketId} for user ${userId}`);
      }
    }
  }

  private broadcastOnlineUsers() {
    const list = Array.from(this.activePresence.entries())
      .map(([socketId, data]) => ({
        userId: data.userId,
        name: data.name,
        autoMatchEnabled: data.autoMatchEnabled,
        isBusy: data.isBusy,
        status: data.status || 'FREE',
        socketId,
      }));

    console.log(`Broadcasting online users list. Count: ${list.length}`);
    this.server.emit('online-users-list', list);
  }

  private getPresenceByUserId(userId: number) {
    const targetUserId = Number(userId);
    return Array.from(this.activePresence.values()).find((p) => p.userId === targetUserId);
  }

  private tryAutoMatch() {
    const freeUsers = Array.from(this.activePresence.entries())
      .map(([_, data]) => data);

    console.log(`AutoMatch Engine: active users count: ${freeUsers.length}`);

    for (const userA of freeUsers) {
      const dataA = this.activePresence.get(userA.socketId);
      if (dataA && dataA.autoMatchEnabled && !dataA.isBusy) {
        
        const partner = freeUsers.find((u) => {
          if (u.socketId === userA.socketId || u.isBusy) return false;
          if (!u.autoMatchEnabled) return false;
          
          const idSelf = userA.userId || userA.socketId;
          const idPartner = u.userId || u.socketId;
          const swipedPartner = this.immediateSwipedPartner.get(idSelf as any);
          if (swipedPartner && swipedPartner === idPartner) return false;

          // Prevent matching own account in multiple tabs
          if (userA.userId && u.userId && userA.userId === u.userId) return false;

          return true;
        });

        if (partner) {
          const dataB = this.activePresence.get(partner.socketId);
          if (dataA) {
            dataA.isBusy = true;
            dataA.status = 'BUSY';
          }
          if (dataB) {
            dataB.isBusy = true;
            dataB.status = 'BUSY';
          }

          const roomCode = `match-${userA.socketId}-${partner.socketId}`;
          console.log(`AutoMatch Pairing: ${userA.name} ↔ ${partner.name}. Room: ${roomCode}`);

          this.server.to(userA.socketId).emit('auto-match-redirect', { roomCode });
          this.server.to(partner.socketId).emit('auto-match-redirect', { roomCode });
        }
      }
    }

    this.broadcastOnlineUsers();
  }

  @SubscribeMessage('register-presence')
  handleRegisterPresence(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { userId: number; name: string; autoMatchEnabled: boolean },
  ) {
    const { userId, name, autoMatchEnabled } = payload;
    console.log(`Presence registered: user ${userId} (${name}), autoMatch: ${autoMatchEnabled}`);

    // Register presence (automatically resets isBusy to false when they return to dashboard)
    if (userId) {
      this.cleanDuplicatePresence(userId, client.id);
    }
    this.activePresence.set(client.id, {
      socketId: client.id,
      userId: userId ? Number(userId) : null,
      name,
      autoMatchEnabled,
      isBusy: false,
      status: 'FREE',
    });

    // Broadcast updated online list to everyone
    this.broadcastOnlineUsers();

    // Trigger auto match if enabled
    if (autoMatchEnabled) {
      this.tryAutoMatch();
    }
  }

  @SubscribeMessage('call-user')
  handleCallUser(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { targetUserId: number; roomCode: string },
  ) {
    const { targetUserId, roomCode } = payload;
    const target = this.getPresenceByUserId(targetUserId);
    if (target) {
      const callerName = this.activePresence.get(client.id)?.name || 'Stranger';

      this.server.to(target.socketId).emit('incoming-ring', {
        callerSocketId: client.id,
        callerName,
        roomCode,
      });
    }
  }

  @SubscribeMessage('accept-call')
  handleAcceptCall(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { callerSocketId: string; roomCode: string },
  ) {
    const { callerSocketId, roomCode } = payload;

    // Set both users to busy
    const presenceA = this.activePresence.get(client.id);
    if (presenceA) presenceA.isBusy = true;
    const presenceB = this.activePresence.get(callerSocketId);
    if (presenceB) presenceB.isBusy = true;

    this.broadcastOnlineUsers();

    this.server.to(client.id).emit('call-connected', { roomCode });
    this.server.to(callerSocketId).emit('call-connected', { roomCode });
  }

  @SubscribeMessage('decline-call')
  handleDeclineCall(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { callerSocketId: string },
  ) {
    this.server.to(payload.callerSocketId).emit('call-declined');
  }

  @SubscribeMessage('cancel-call')
  handleCancelCall(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { targetUserId: number },
  ) {
    const target = this.getPresenceByUserId(payload.targetUserId);
    if (target) {
      this.server.to(target.socketId).emit('call-cancelled');
    }
  }

  @SubscribeMessage('send-direct-message')
  handleSendDirectMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { targetUserId: number; content: string },
  ) {
    const { targetUserId, content } = payload;
    const target = this.getPresenceByUserId(targetUserId);
    if (target) {
      // Find sender details
      const senderPresence = this.activePresence.get(client.id);
      const senderUserId = senderPresence?.userId || 0;
      const senderName = senderPresence?.name || 'Stranger';

      this.server.to(target.socketId).emit('incoming-direct-message', {
        senderUserId,
        senderName,
        content,
        createdAt: new Date().toISOString(),
      });
    }
  }
}
