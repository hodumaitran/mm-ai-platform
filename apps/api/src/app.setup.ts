import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import type { Environment } from './config/environment';

export function configureApplication(app: INestApplication): void {
  const config = app.get(ConfigService<Environment, true>);
  const bodyLimit = config.get('API_REQUEST_BODY_LIMIT_BYTES', { infer: true });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      stopAtFirstError: false,
      transform: true,
      whitelist: true,
    }),
  );
  (app as NestExpressApplication).useBodyParser('json', { limit: bodyLimit });
}
