import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { MessageRole, MessageStatus } from '../generated/prisma/client';
import { DEFAULT_TITLE } from './context-history';
import { GenerationService } from './generation.service';

export type ConversationSummary = {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
};

export type MessageView = {
  id: string;
  seq: number;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  errorCode: string | null;
  createdAt: Date;
};

const MAX_MESSAGES_RETURNED = 500;
const SUMMARY = { id: true, title: true, createdAt: true, updatedAt: true } as const;

/** Every query carries the owner id: ownership is enforced at the database query boundary. */
@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generation: GenerationService,
  ) {}

  create(userId: string, title: string | undefined): Promise<ConversationSummary> {
    return this.prisma.conversation.create({
      data: { userId, title: title?.trim() || DEFAULT_TITLE },
      select: SUMMARY,
    });
  }

  async list(
    userId: string,
    query: { q: string | undefined; page: number; pageSize: number },
  ): Promise<{ items: ConversationSummary[]; total: number; page: number; pageSize: number }> {
    const where = {
      userId,
      ...(query.q !== undefined && query.q.trim() !== ''
        ? { title: { contains: query.q.trim(), mode: 'insensitive' as const } }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.conversation.findMany({
        where,
        select: SUMMARY,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.conversation.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async messages(
    userId: string,
    conversationId: string,
  ): Promise<{ conversation: ConversationSummary; messages: MessageView[] }> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, userId },
      select: SUMMARY,
    });
    if (conversation === null) throw new NotFoundException();
    const newest = await this.prisma.message.findMany({
      where: { conversationId },
      select: {
        id: true,
        seq: true,
        role: true,
        content: true,
        status: true,
        errorCode: true,
        createdAt: true,
      },
      orderBy: { seq: 'desc' },
      take: MAX_MESSAGES_RETURNED,
    });
    return { conversation, messages: newest.reverse() };
  }

  async rename(
    userId: string,
    conversationId: string,
    title: string,
  ): Promise<ConversationSummary> {
    const result = await this.prisma.conversation.updateMany({
      where: { id: conversationId, userId },
      data: { title: title.trim() },
    });
    if (result.count === 0) throw new NotFoundException();
    return this.prisma.conversation.findFirstOrThrow({
      where: { id: conversationId, userId },
      select: SUMMARY,
    });
  }

  async remove(userId: string, conversationId: string): Promise<void> {
    const result = await this.prisma.conversation.deleteMany({
      where: { id: conversationId, userId },
    });
    if (result.count === 0) throw new NotFoundException();
    this.generation.abortConversation(conversationId);
  }
}
