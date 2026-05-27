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
  // Format: userId => { socketId, name, autoMatchEnabled, isBusy }
  private activePresence = new Map<
    number,
    {
      socketId: string;
      name: string;
      autoMatchEnabled: boolean;
      isBusy: boolean;
    }
  >();

  // Tracks matchmaking history of who met whom so they are not automatically matched again
  // Format: userId => Set of userIds they have already matched with
  private matchedHistory = new Map<number, Set<number>>();

  constructor(private meetingsService: MeetingsService) {}

  handleConnection(client: Socket) {
    console.log(`Socket Client Connected: ${client.id}`);
  }

  async handleDisconnect(client: Socket) {
    console.log(`Socket Client Disconnected: ${client.id}`);

    // Remove from active presence if this was a registered presence socket
    let foundPresence = false;
    for (const [userId, data] of this.activePresence.entries()) {
      if (data.socketId === client.id) {
        this.activePresence.delete(userId);
        foundPresence = true;
        console.log(`Presence removed for disconnected user: ${userId}`);
        break;
      }
    }
    if (foundPresence) {
      this.broadcastOnlineUsers();
    }

    const session = this.socketRegistry.get(client.id);
    
    if (session) {
      const { roomId, userId, name, participantId } = session;
      
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

  // --- REAL-TIME PRESENCE & AUTOMATIC MATCHMAKING ENGINE ---

  private broadcastOnlineUsers() {
    const list = Array.from(this.activePresence.entries())
      .filter(([_, data]) => !data.isBusy) // Only available users show up in list
      .map(([userId, data]) => ({
        userId,
        name: data.name,
        autoMatchEnabled: data.autoMatchEnabled,
      }));

    console.log(`Broadcasting online users list. Count: ${list.length}`);
    this.server.emit('online-users-list', list);
  }

  private tryAutoMatch() {
    // Find all users who are currently in the active presence registry
    const freeUsers = Array.from(this.activePresence.entries())
      .map(([userId, data]) => ({ userId, ...data }));

    console.log(`AutoMatch Engine: active users count: ${freeUsers.length}`);

    // Pair any user who has autoMatchEnabled: true (i.e. first-time registrations)
    for (const userA of freeUsers) {
      const dataA = this.activePresence.get(userA.userId);
      if (dataA && dataA.autoMatchEnabled && !dataA.isBusy) {
        
        // Find ANY active online user who is:
        // 1. Not userA
        // 2. Not currently busy in a call
        // 3. Has not matched with userA before during this server session
        const partner = freeUsers.find((u) => {
          if (u.userId === userA.userId || u.isBusy) return false;
          const alreadyMatched = this.matchedHistory.get(userA.userId)?.has(u.userId) || false;
          return !alreadyMatched;
        });

        if (partner) {
          // Mark both users as busy in registry
          const dataB = this.activePresence.get(partner.userId);
          if (dataA) dataA.isBusy = true;
          if (dataB) dataB.isBusy = true;

          // Record match history for both users
          if (!this.matchedHistory.has(userA.userId)) {
            this.matchedHistory.set(userA.userId, new Set());
          }
          if (!this.matchedHistory.has(partner.userId)) {
            this.matchedHistory.set(partner.userId, new Set());
          }
          this.matchedHistory.get(userA.userId)!.add(partner.userId);
          this.matchedHistory.get(partner.userId)!.add(userA.userId);

          // Unique match room code
          const roomCode = `match-${userA.userId}-${partner.userId}`;
          console.log(`AutoMatch Pairing (Registration Auto-Connect): ${userA.name} ↔ ${partner.name}. Room: ${roomCode}`);

          // Emit redirection to both sockets
          this.server.to(userA.socketId).emit('auto-match-redirect', { roomCode });
          this.server.to(partner.socketId).emit('auto-match-redirect', { roomCode });
        }
      }
    }

    // Broadcast updated available lists
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
    this.activePresence.set(userId, {
      socketId: client.id,
      name,
      autoMatchEnabled,
      isBusy: false,
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
    const target = this.activePresence.get(targetUserId);
    if (target) {
      // Find caller name
      let callerName = 'Stranger';
      for (const [uid, data] of this.activePresence.entries()) {
        if (data.socketId === client.id) {
          callerName = data.name;
          break;
        }
      }

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
    for (const [uid, data] of this.activePresence.entries()) {
      if (data.socketId === client.id || data.socketId === callerSocketId) {
        data.isBusy = true;
      }
    }
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
    const target = this.activePresence.get(payload.targetUserId);
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
    const target = this.activePresence.get(targetUserId);
    if (target) {
      // Find sender details
      let senderUserId = 0;
      let senderName = 'Stranger';
      for (const [uid, data] of this.activePresence.entries()) {
        if (data.socketId === client.id) {
          senderUserId = uid;
          senderName = data.name;
          break;
        }
      }

      this.server.to(target.socketId).emit('incoming-direct-message', {
        senderUserId,
        senderName,
        content,
        createdAt: new Date().toISOString(),
      });
    }
  }
}
