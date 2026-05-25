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

  constructor(private meetingsService: MeetingsService) {}

  handleConnection(client: Socket) {
    console.log(`Socket Client Connected: ${client.id}`);
  }

  async handleDisconnect(client: Socket) {
    console.log(`Socket Client Disconnected: ${client.id}`);
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

      // Persist the message in MySQL
      const message = await this.meetingsService.saveMessage(
        roomId,
        userId,
        name,
        payload.content,
      );

      // Broadcast message to everyone in room (including sender)
      this.server.to(roomId).emit('message', {
        id: message.id,
        senderName: name,
        userId,
        content: payload.content,
        createdAt: message.createdAt,
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
}
