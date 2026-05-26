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

  async googleLogin(idToken: string) {
    try {
      // 1. Verify token with Google's secure tokeninfo API
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
      if (!res.ok) {
        throw new UnauthorizedException('Invalid Google ID Token');
      }

      const payload = await res.json() as {
        sub: string;
        email: string;
        name: string;
        aud: string;
      };

      // 2. Validate Google Client ID (Audience) to prevent token spoofing
      const GOOGLE_CLIENT_ID = '365752923604-rdgmvemsali9e81ifc3a169h47o5i6ln.apps.googleusercontent.com';
      if (payload.aud !== GOOGLE_CLIENT_ID) {
        throw new UnauthorizedException('Google Token Audience Mismatch');
      }

      // 3. Find or create user
      let user = await this.usersService.findByGoogleId(payload.sub);
      let isNewUser = false;
      
      if (!user) {
        // Check if a user with this email already exists
        const existingEmailUser = await this.usersService.findByEmail(payload.email);
        
        if (existingEmailUser) {
          // Link Google account to their existing email profile
          await this.usersService.linkGoogleAccount(existingEmailUser.id, payload.sub);
          user = await this.usersService.findByGoogleId(payload.sub);
        } else {
          isNewUser = true;
          // Create new account with secure random placeholder password
          const placeholderPassword = await bcrypt.hash(`google_sso_${payload.sub}_${Date.now()}`, 10);
          user = await this.usersService.create({
            name: payload.name || payload.email.split('@')[0],
            email: payload.email,
            password: placeholderPassword,
            googleId: payload.sub,
          });
        }
      }

      if (!user) {
        throw new BadRequestException('Failed to process Google sign-in profile');
      }

      // 4. Generate system access & refresh JWT tokens
      const tokens = await this.generateTokens(user.id, user.email, user.name);
      await this.updateRefreshToken(user.id, tokens.refreshToken);

      return {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
        },
        isNewUser,
        ...tokens,
      };
    } catch (err) {
      if (err instanceof UnauthorizedException || err instanceof BadRequestException) {
        throw err;
      }
      console.error('Google token verification error:', err);
      throw new UnauthorizedException('Google authentication failed');
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
