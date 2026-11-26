import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/auth.decorators';
import { PrismaService } from '../database/prisma.service';
import { HealthResponse, HealthService } from './health.service';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly healthService: HealthService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  getHealth(): HealthResponse {
    return this.healthService.getHealth();
  }

  /** Readiness includes the database; it reports no connection details. */
  @Get('ready')
  async getReady(): Promise<{ service: 'api'; status: 'ok'; database: 'up' }> {
    if (!(await this.prisma.isReady())) throw new ServiceUnavailableException();
    return { service: 'api', status: 'ok', database: 'up' };
  }
}
