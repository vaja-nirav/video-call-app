import { Controller, Post, Get, Body, Param } from '@nestjs/common';
import { MeetingsService } from './meetings.service';

@Controller('meetings')
export class MeetingsController {
  constructor(private meetingsService: MeetingsService) {}

  @Post('create')
  async create(@Body() body: { title?: string }) {
    return this.meetingsService.createGuestMeeting(body.title);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.meetingsService.findOne(id);
  }

  @Get(':id/messages')
  async getMessages(@Param('id') id: string) {
    return this.meetingsService.getMessages(id);
  }
}
