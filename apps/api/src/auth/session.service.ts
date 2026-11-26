import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Environment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import type { AuthContext } from './auth.types';

const TOUCH_INTERVAL_MS = 60_000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class SessionService {
  private readonly ttlMs: number;
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Environment, true>,
  ) {
    this.ttlMs = config.get('SESSION_TTL_SECONDS', { infer: true }) * 1000;
    this.secret = config.get('SESSION_SECRET', { infer: true });
  }

  /** Creates a session; only the SHA-256 of the opaque token is stored. */
  async create(userId: string): Promise<{ token: string; expiresAt: Date; csrfToken: string }> {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + this.ttlMs);
    await this.prisma.session.create({ data: { userId, tokenHash, expiresAt } });
    // Opportunistic cleanup keeps the table small without a scheduler.
    await this.prisma.session.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - 86_400_000) } },
    });
    return { token, expiresAt, csrfToken: this.csrfFor(tokenHash) };
  }

  async validate(token: string): Promise<AuthContext | null> {
    const tokenHash = hashToken(token);
    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    const now = new Date();
    if (
      session === null ||
      session.revokedAt !== null ||
      session.expiresAt <= now ||
      !session.user.isActive
    ) {
      return null;
    }
    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: now } });
    }
    const { id, email, displayName, role } = session.user;
    return {
      user: { id, email, displayName, role },
      sessionId: session.id,
      csrfToken: this.csrfFor(tokenHash),
    };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** CSRF token bound to the session and the server secret; it is never stored. */
  csrfFor(tokenHash: string): string {
    return createHmac('sha256', this.secret).update(`csrf:${tokenHash}`).digest('base64url');
  }

  csrfMatches(expected: string, supplied: string | undefined): boolean {
    if (supplied === undefined) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(supplied);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
