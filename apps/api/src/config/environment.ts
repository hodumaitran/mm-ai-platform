export type Environment = {
  NODE_ENV: 'development' | 'test' | 'production';
  API_HOST: string;
  API_PORT: number;
};

function parseNodeEnvironment(value: unknown): Environment['NODE_ENV'] {
  const nodeEnvironment = readString(value, 'development', 'NODE_ENV');
  switch (nodeEnvironment) {
    case 'development':
    case 'test':
    case 'production':
      return nodeEnvironment;
    default:
      throw new Error('NODE_ENV must be development, test, or production');
  }
}

function parsePort(value: unknown): number {
  const port = Number(value ?? '3001');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('API_PORT must be an integer between 1 and 65535');
  }
  return port;
}

function readString(value: unknown, fallback: string, name: string): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

export function validateEnvironment(input: Record<string, unknown>): Environment {
  const nodeEnv = parseNodeEnvironment(input.NODE_ENV);
  const host = readString(input.API_HOST, '127.0.0.1', 'API_HOST').trim();
  if (host.length === 0) {
    throw new Error('API_HOST must not be empty');
  }
  return {
    NODE_ENV: nodeEnv,
    API_HOST: host,
    API_PORT: parsePort(input.API_PORT),
  };
}
