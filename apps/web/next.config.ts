import type { NextConfig } from 'next';
import { validateWebEnvironment } from './src/server/environment.ts';

export { validateWebEnvironment } from './src/server/environment.ts';

validateWebEnvironment(process.env);

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
