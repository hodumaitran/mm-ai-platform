import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Role } from '../generated/prisma/client';
import { normalizeEmail } from '../auth/auth.controller';
import { PasswordService } from '../auth/password.service';
import { SessionService } from '../auth/session.service';
import { PrismaService } from '../database/prisma.service';

export type UserSummary = {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
};

const SUMMARY = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  isActive: true,
  createdAt: true,
  lastLoginAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
  ) {}

  async create(input: {
    email: string;
    displayName: string;
    password: string;
    role: Role;
  }): Promise<UserSummary> {
    const passwordHash = await this.passwords.hash(input.password);
    try {
      return await this.prisma.user.create({
        data: {
          email: normalizeEmail(input.email),
          displayName: input.displayName.trim(),
          passwordHash,
          role: input.role,
        },
        select: SUMMARY,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException();
      }
      throw error;
    }
  }

  async list(
    page: number,
    pageSize: number,
  ): Promise<{
    items: UserSummary[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        select: SUMMARY,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count(),
    ]);
    return { items, total, page, pageSize };
  }

  async setActive(id: string, isActive: boolean): Promise<UserSummary> {
    const existing = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (existing === null) throw new NotFoundException();
    const user = await this.prisma.user.update({
      where: { id },
      data: { isActive },
      select: SUMMARY,
    });
    // Deactivation takes effect immediately: every session of the account is revoked.
    if (!isActive) await this.sessions.revokeAllForUser(id);
    return user;
  }
}
