import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { GenerationService } from './generation.service';

@Module({
  imports: [AiModule],
  controllers: [ConversationsController],
  providers: [ConversationsService, GenerationService],
})
export class ConversationsModule {}
