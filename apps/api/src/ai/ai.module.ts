import { Module } from '@nestjs/common';
import { AiServiceClient } from './ai-service.client';

/** Private AI service client. No controller is exposed: chat is reachable only through the authenticated conversations API. */
@Module({ providers: [AiServiceClient], exports: [AiServiceClient] })
export class AiModule {}
