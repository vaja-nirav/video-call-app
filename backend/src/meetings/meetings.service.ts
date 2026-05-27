import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MeetingsService {
  constructor(private prisma: PrismaService) {}

  // Create a new meeting room in MySQL database
  async create(hostId: number, title?: string) {
    return this.prisma.meeting.create({
      data: {
        hostId,
        title: title || 'Instant Meeting',
      },
    });
  }

  // Create a new guest meeting room in MySQL database without requiring a JWT user
  async createGuestMeeting(title?: string) {
    let host = await this.prisma.user.findFirst();
    if (!host) {
      host = await this.prisma.user.create({
        data: {
          name: 'Guest Host',
          email: 'guest@meetsync.com',
          password: 'guest_unsecured_password',
        },
      });
    }
    return this.prisma.meeting.create({
      data: {
        hostId: host.id,
        title: title || 'Instant Meeting',
      },
    });
  }

  // Retrieve a specific meeting with its host details
  async findOne(id: string) {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id },
      include: {
        host: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    if (!meeting) {
      throw new NotFoundException('Meeting room not found');
    }

    return meeting;
  }

  // Register a participant joining the meeting
  async addParticipant(meetingId: string, userId?: number, guestName?: string, role: string = 'PARTICIPANT') {
    try {
      const meetingExists = await this.prisma.meeting.findUnique({
        where: { id: meetingId },
      });

      if (!meetingExists) {
        console.log(`Meeting ${meetingId} not found in DB. Creating dynamically.`);
        let hostId = userId || 1;
        const hostUser = await this.prisma.user.findUnique({ where: { id: hostId } });
        if (!hostUser) {
          const firstUser = await this.prisma.user.findFirst();
          hostId = firstUser ? firstUser.id : 1;
        }
        await this.prisma.meeting.create({
          data: {
            id: meetingId,
            hostId,
            title: 'Auto-Created Meeting Room',
          },
        });
      }
    } catch (err) {
      console.error(`Failed to auto-create meeting room ${meetingId}:`, err);
    }

    return this.prisma.participant.create({
      data: {
        meetingId,
        userId,
        guestName,
        role,
        joinedAt: new Date(),
      },
    });
  }

  // Log a participant leaving the meeting
  async removeParticipant(participantId: number) {
    return this.prisma.participant.update({
      where: { id: participantId },
      data: { leftAt: new Date() },
    });
  }

  // Log a participant's live camera/mute/hand states
  async updateParticipantState(
    participantId: number,
    state: { isMuted?: boolean; isCameraOff?: boolean; isHandRaised?: boolean },
  ) {
    return this.prisma.participant.update({
      where: { id: participantId },
      data: state,
    });
  }

  // Save an in-meeting chat message
  async saveMessage(meetingId: string, userId: number | null, senderName: string, content: string) {
    return this.prisma.message.create({
      data: {
        meetingId,
        userId,
        senderName,
        content,
        createdAt: new Date(),
      },
    });
  }

  // Retrieve message history for a meeting
  async getMessages(meetingId: string) {
    return this.prisma.message.findMany({
      where: { meetingId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // Create a call log audit event
  async createCallLog(meetingId: string, userId: number | null, action: string, details?: string) {
    return this.prisma.callLog.create({
      data: {
        meetingId,
        userId,
        action,
        details,
        timestamp: new Date(),
      },
    });
  }
}
