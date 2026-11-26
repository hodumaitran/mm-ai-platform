import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Role } from '../generated/prisma/client';
import type { AuthContext, AuthenticatedRequest } from './auth.types';

export const IS_PUBLIC = 'mm:isPublic';
export const ROLES = 'mm:roles';

/** Opt a route out of the global session guard (login, health). Everything else is protected. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES, roles);

/** The authenticated principal, derived only from the server-side session. */
export const Auth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.auth === undefined) {
      throw new Error('Auth decorator used on an unauthenticated route');
    }
    return request.auth;
  },
);
