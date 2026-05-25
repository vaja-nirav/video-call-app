import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import * as bcrypt from 'bcrypt';
import 'dotenv/config';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
  ) {}

  async register(data: { name: string; email: string; password: string }) {
    const existingUser = await this.usersService.findByEmail(data.email);
    if (existingUser) {
      throw new BadRequestException('User with this email already exists');
    }

    // Hash the password before saving
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(data.password, salt);

    const user = await this.usersService.create({
      name: data.name,
      email: data.email,
      password: hashedPassword,
    });

    const tokens = await this.generateTokens(user.id, user.email, user.name);
    await this.updateRefreshToken(user.id, tokens.refreshToken);

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
      ...tokens,
    };
  }

  async login(data: { email: string; password: string }) {
    const user = await this.usersService.findByEmail(data.email);
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isPasswordValid = await bcrypt.compare(data.password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const tokens = await this.generateTokens(user.id, user.email, user.name);
    await this.updateRefreshToken(user.id, tokens.refreshToken);

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
      ...tokens,
    };
  }

  async refresh(userId: number, refreshToken: string) {
    const user = await this.prismaFindUserRaw(userId);
    if (!user || !user.refreshToken) {
      throw new UnauthorizedException('Access Denied');
    }

    // Compare raw refresh token with hashed refresh token in database
    const isTokenValid = await bcrypt.compare(refreshToken, user.refreshToken);
    if (!isTokenValid) {
      throw new UnauthorizedException('Invalid Refresh Token');
    }

    const tokens = await this.generateTokens(user.id, user.email, user.name);
    await this.updateRefreshToken(user.id, tokens.refreshToken);

    return tokens;
  }

  async logout(userId: number) {
    await this.usersService.updateRefreshToken(userId, null);
    return { success: true, message: 'Logged out successfully' };
  }

  // Helper method to sign and return access & refresh tokens
  async generateTokens(userId: number, email: string, name: string) {
    const payload = { sub: userId, email, name };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: process.env.JWT_SECRET || 'super-secret-key-12345-video-calling',
        expiresIn: '15m',
      }),
      this.jwtService.signAsync(payload, {
        secret: process.env.JWT_REFRESH_SECRET || 'super-secret-refresh-key-67890-video-calling',
        expiresIn: '7d',
      }),
    ]);

    return {
      accessToken,
      refreshToken,
    };
  }

  // Update hashed refresh token in database
  async updateRefreshToken(userId: number, refreshToken: string | null) {
    if (refreshToken) {
      const salt = await bcrypt.genSalt(10);
      const hashedToken = await bcrypt.hash(refreshToken, salt);
      await this.usersService.updateRefreshToken(userId, hashedToken);
    } else {
      await this.usersService.updateRefreshToken(userId, null);
    }
  }

  // Raw find to grab password & refreshToken for internal validation
  private async prismaFindUserRaw(userId: number) {
    const user = await this.usersService.findById(userId);
    if (!user) {
      return null;
    }
    return this.usersService.findByEmail(user.email);
  }
}
