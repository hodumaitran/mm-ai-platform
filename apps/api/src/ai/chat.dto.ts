import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';

export type PublicMessageRole = 'user' | 'assistant';
export type PublicThinkingMode = 'disabled' | 'enabled';

export class ChatMessageDto {
  @IsIn(['user', 'assistant'])
  role!: PublicMessageRole;

  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  content!: string;
}

@ValidatorConstraint({ name: 'conversationSequence', async: false })
class ConversationSequenceConstraint implements ValidatorConstraintInterface {
  validate(messages: unknown): boolean {
    if (!Array.isArray(messages)) {
      return false;
    }
    let expected: PublicMessageRole = 'user';
    let totalCharacters = 0;
    for (const value of messages) {
      if (!(value instanceof ChatMessageDto) || value.role !== expected || !value.content.trim()) {
        return false;
      }
      totalCharacters += value.content.length;
      expected = expected === 'user' ? 'assistant' : 'user';
    }
    const last: unknown = (messages as unknown[]).at(-1);
    return last instanceof ChatMessageDto && last.role === 'user' && totalCharacters <= 3072;
  }
}

export class GenerationDto {
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(2)
  temperature = 0.2;

  @IsInt()
  @Min(1)
  @Max(1024)
  max_output_tokens = 256;
}

export class ThinkingDto {
  @IsIn(['disabled', 'enabled'])
  mode: PublicThinkingMode = 'disabled';
}

export class ChatCompletionDto {
  @IsOptional()
  @IsIn(['1'])
  version = '1';

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  @Validate(ConversationSequenceConstraint)
  messages!: ChatMessageDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => GenerationDto)
  generation = new GenerationDto();

  @IsOptional()
  @ValidateNested()
  @Type(() => ThinkingDto)
  thinking = new ThinkingDto();
}

export type TokenUsage = {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
};

export type ChatCompletionResponse = {
  version: '1';
  request_id: string;
  model: string;
  message: { role: 'assistant'; content: string };
  finish_reason: string;
  usage: TokenUsage;
};
