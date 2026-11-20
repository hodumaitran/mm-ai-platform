import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApplication } from './app.setup';
import type { Environment } from './config/environment';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService<Environment, true>);
  configureApplication(app);
  app.enableShutdownHooks();
  await app.listen(
    config.get('API_PORT', { infer: true }),
    config.get('API_HOST', { infer: true }),
  );
}

void bootstrap();
