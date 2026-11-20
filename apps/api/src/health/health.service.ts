import { Injectable } from '@nestjs/common';

export type HealthResponse = { service: 'api'; status: 'ok' };

@Injectable()
export class HealthService {
  getHealth(): HealthResponse {
    return { service: 'api', status: 'ok' };
  }
}
