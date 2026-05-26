import { Controller, Post, Body, Get, UseGuards, Req, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  async register(
    @Body() body: { name: string; email: string; password: string },
  ) {
    return this.authService.register(body);
  }

  @Post('login')
  async login(
    @Body() body: { email: string; password: string },
  ) {
    return this.authService.login(body);
  }

  @Post('google-login')
  async googleLogin(
    @Body() body: { idToken: string },
  ) {
    return this.authService.googleLogin(body.idToken);
  }

  @Post('refresh')
  async refresh(
    @Body() body: { userId: number; refreshToken: string },
  ) {
    if (!body.userId || !body.refreshToken) {
      throw new UnauthorizedException('Missing userId or refreshToken');
    }
    return this.authService.refresh(body.userId, body.refreshToken);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  async logout(@CurrentUser() user: { id: number }) {
    return this.authService.logout(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  async profile(@CurrentUser() user: any) {
    return user;
  }
}
