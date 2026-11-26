import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Environment } from '../config/environment';
import type { Role } from '../generated/prisma/client';
import { IS_PUBLIC, ROLES } from './auth.decorators';
import type { AuthenticatedRequest } from './auth.types';
import { readCookie, sessionCookieName } from './cookies';
import { SessionService } from './session.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard: NestJS is the authoritative authentication and authorization boundary.
 * Order: origin check (state-changing) -> session -> CSRF token -> role.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly allowedOrigins: Set<string>;
  private readonly cookieName: string;

  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    config: ConfigService<Environment, true>,
  ) {
    this.allowedOrigins = new Set(config.get('APP_ALLOWED_ORIGINS', { infer: true }));
    this.cookieName = sessionCookieName(config.get('SESSION_COOKIE_SECURE', { infer: true }));
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const stateChanging = !SAFE_METHODS.has(request.method);
    if (stateChanging) {
      const origin = request.headers.origin;
      if (origin !== undefined && !this.allowedOrigins.has(origin)) {
        throw new ForbiddenException();
      }
    }
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const token = readCookie(request.headers.cookie, this.cookieName);
    const auth = token === undefined ? null : await this.sessions.validate(token);
    if (auth === null) throw new UnauthorizedException();
    if (stateChanging) {
      const supplied = request.headers['x-csrf-token'];
      const header = typeof supplied === 'string' ? supplied : undefined;
      if (!this.sessions.csrfMatches(auth.csrfToken, header)) throw new ForbiddenException();
    }
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles !== undefined && !roles.includes(auth.user.role)) throw new ForbiddenException();
    request.auth = auth;
    return true;
  }
}
