import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsString, MaxLength, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import type { Environment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { Auth, Public } from './auth.decorators';
import { publicUser, type AuthContext } from './auth.types';
import { sessionCookieName } from './cookies';
import { LoginRateLimiter, retryAfterSeconds } from './login-rate-limiter';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class LoginDto {
  @IsString()
  @MinLength(3)
  @MaxLength(254)
  email!: string;

  // The upper bound limits hashing work an attacker can force per request.
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password!: string;
}

@Controller('auth')
export class AuthController {
  private readonly cookieName: string;
  private readonly secure: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly limiter: LoginRateLimiter,
    config: ConfigService<Environment, true>,
  ) {
    this.secure = config.get('SESSION_COOKIE_SECURE', { infer: true });
    this.cookieName = sessionCookieName(this.secure);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ user: ReturnType<typeof publicUser>; csrfToken: string }> {
    const email = normalizeEmail(body.email);
    const keys = [`email:${email}`, `ip:${clientAddress(request)}`];
    try {
      this.limiter.assertAllowed(keys);
    } catch (error) {
      if (error instanceof HttpException) {
        response.setHeader('Retry-After', String(retryAfterSeconds(error)));
      }
      throw error;
    }
    const user = await this.prisma.user.findUnique({ where: { email } });
    // One generic outcome for unknown account, wrong password and disabled account.
    let valid = false;
    if (user === null) {
      await this.passwords.verifyAgainstDummy(body.password);
    } else {
      valid = await this.passwords.verify(user.passwordHash, body.password);
    }
    if (user === null || !valid || !user.isActive) {
      this.limiter.recordFailure(keys);
      throw new UnauthorizedException();
    }
    this.limiter.reset(keys[0] as string);
    const session = await this.sessions.create(user.id);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    response.cookie(this.cookieName, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.secure,
      path: '/',
      expires: session.expiresAt,
    });
    response.setHeader('Cache-Control', 'no-store');
    return { user: publicUser(user), csrfToken: session.csrfToken };
  }

  @Get('me')
  me(
    @Auth() auth: AuthContext,
    @Res({ passthrough: true }) response: Response,
  ): { user: ReturnType<typeof publicUser>; csrfToken: string } {
    response.setHeader('Cache-Control', 'no-store');
    return { user: publicUser(auth.user), csrfToken: auth.csrfToken };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Auth() auth: AuthContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.sessions.revoke(auth.sessionId);
    response.clearCookie(this.cookieName, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.secure,
      path: '/',
    });
  }
}

/** NestJS only listens on loopback behind the Next.js server, which supplies X-Forwarded-For. */
function clientAddress(request: Request): string {
  const forwarded = request.headers['x-forwarded-for'];
  const first = typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined;
  const value =
    first !== undefined && first.length > 0 ? first : (request.socket.remoteAddress ?? 'unknown');
  return value.slice(0, 64);
}
