import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { Request, Response } from 'express';
import { Auth } from '../auth/auth.decorators';
import type { AuthContext } from '../auth/auth.types';
import {
  ConversationsService,
  type ConversationSummary,
  type MessageView,
} from './conversations.service';
import { GenerationService } from './generation.service';

export class CreateConversationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  title?: string;
}

export class RenameConversationDto {
  @IsString()
  @MaxLength(60)
  @Matches(/\S/)
  title!: string;
}

export class ListConversationsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number;
}

export class SendMessageDto {
  @IsString()
  @MaxLength(2048)
  @Matches(/\S/)
  content!: string;

  // Idempotency key: a retry of the same submission reuses the stored message.
  @IsUUID()
  clientRequestId!: string;
}

/** The authenticated user id always comes from the session, never from the request. */
@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly generation: GenerationService,
  ) {}

  @Post()
  create(
    @Auth() auth: AuthContext,
    @Body() body: CreateConversationDto,
  ): Promise<ConversationSummary> {
    return this.conversations.create(auth.user.id, body.title);
  }

  @Get()
  list(
    @Auth() auth: AuthContext,
    @Query() query: ListConversationsQuery,
  ): ReturnType<ConversationsService['list']> {
    return this.conversations.list(auth.user.id, {
      q: query.q,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 30,
    });
  }

  @Get(':id/messages')
  messages(
    @Auth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ conversation: ConversationSummary; messages: MessageView[] }> {
    return this.conversations.messages(auth.user.id, id);
  }

  @Patch(':id')
  rename(
    @Auth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RenameConversationDto,
  ): Promise<ConversationSummary> {
    return this.conversations.rename(auth.user.id, id, body.title);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Auth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    return this.conversations.remove(auth.user.id, id);
  }

  @Post(':id/messages')
  async send(
    @Auth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SendMessageDto,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const prepared = await this.generation.prepare(auth.user.id, id, {
      kind: 'send',
      content: body.content,
      clientRequestId: body.clientRequestId,
    });
    await this.generation.run(prepared, request, response);
  }

  @Post(':id/regenerate')
  async regenerate(
    @Auth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const prepared = await this.generation.prepare(auth.user.id, id, { kind: 'regenerate' });
    await this.generation.run(prepared, request, response);
  }
}
