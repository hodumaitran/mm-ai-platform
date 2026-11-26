import {
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { Auth } from '../auth/auth.decorators';
import type { AuthContext } from '../auth/auth.types';
import { DocumentKind, DocumentStatus } from '../generated/prisma/client';
import { attachmentDisposition } from './document-files';
import { DocumentsService, type ChunkView, type DocumentView } from './documents.service';

export class ListDocumentsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsIn(Object.values(DocumentStatus))
  status?: DocumentStatus;

  @IsOptional()
  @IsIn(Object.values(DocumentKind))
  kind?: DocumentKind;

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

export class ListChunksQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number;
}

/** The owner id always comes from the session; documents of other users are simply not found. */
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post()
  @HttpCode(201)
  upload(@Auth() auth: AuthContext, @Req() request: Request): Promise<DocumentView> {
    return this.documents.ingest(auth.user.id, request);
  }

  @Get()
  list(
    @Auth() auth: AuthContext,
    @Query() query: ListDocumentsQuery,
  ): ReturnType<DocumentsService['list']> {
    return this.documents.list(auth.user.id, {
      q: query.q,
      status: query.status,
      kind: query.kind,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
    });
  }

  @Get(':id')
  get(
    @Auth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<DocumentView> {
    return this.documents.get(auth.user.id, id);
  }

  @Get(':id/chunks')
  chunks(
    @Auth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: ListChunksQuery,
  ): Promise<{ items: ChunkView[]; total: number; page: number; pageSize: number }> {
    return this.documents.chunks(auth.user.id, id, query.page ?? 1, query.pageSize ?? 10);
  }

  @Get(':id/download')
  async download(
    @Auth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() response: Response,
  ): Promise<void> {
    const meta = await this.documents.forDownload(auth.user.id, id);
    const file = await this.documents.open(meta.storageKey);
    if (file === null) throw new NotFoundException(); // file missing on disk: no path is revealed
    response.status(200);
    response.setHeader('Content-Type', meta.mediaType);
    response.setHeader('Content-Length', String(file.size));
    response.setHeader('Content-Disposition', attachmentDisposition(meta.filename));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    response.setHeader('Cache-Control', 'no-store');
    try {
      await pipeline(file.stream, response);
    } catch {
      file.stream.destroy();
      if (!response.writableEnded) response.destroy();
    }
  }

  @Post(':id/retry')
  @HttpCode(200)
  retry(
    @Auth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<DocumentView> {
    return this.documents.retry(auth.user.id, id);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Auth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    return this.documents.remove(auth.user.id, id);
  }
}
