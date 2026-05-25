import { Module } from '@nestjs/common';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { MeetingsModule } from './meetings/meetings.module';

@Module({
  imports: [UsersModule, AuthModule, MeetingsModule],
})
export class AppModule {}