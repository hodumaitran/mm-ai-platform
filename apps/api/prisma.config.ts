import { defineConfig } from 'prisma/config';

// DATABASE_URL is validated by the application; the Prisma CLI only needs it for migrate commands.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
