import type { Request } from 'express';
import type { Role } from '../generated/prisma/client';

export type AuthenticatedUser = {
  id: string;
  email: string;
  displayName: string;
  role: Role;
};

export type AuthContext = {
  user: AuthenticatedUser;
  sessionId: string;
  csrfToken: string;
};

export type AuthenticatedRequest = Request & { auth?: AuthContext };

export function publicUser(user: AuthenticatedUser): AuthenticatedUser {
  return { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
}
