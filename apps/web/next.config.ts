import type { NextConfig } from 'next';

export type WebEnvironment = {
  apiBaseUrl: URL;
};

export function validateWebEnvironment(input: Record<string, string | undefined>): WebEnvironment {
  const apiBaseUrl = new URL(input.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3001/api/v1');
  if (!['http:', 'https:'].includes(apiBaseUrl.protocol)) {
    throw new Error('NEXT_PUBLIC_API_BASE_URL must use HTTP or HTTPS');
  }

  return { apiBaseUrl };
}

validateWebEnvironment(process.env);

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
