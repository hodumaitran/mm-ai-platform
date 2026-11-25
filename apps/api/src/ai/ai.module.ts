import { Module } from '@nestjs/common';
import { AiServiceClient } from './ai-service.client';
import { ChatController } from './chat.controller';

@Module({
  controllers: [ChatController],
  providers: [AiServiceClient],
})
export class AiModule {}
