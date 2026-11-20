import { HealthService } from './health.service';

describe('HealthService', () => {
  it('reports the API process as healthy', () => {
    expect(new HealthService().getHealth()).toEqual({ service: 'api', status: 'ok' });
  });
});
