/**
 * Creates the first administrator from explicitly supplied credentials.
 *
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... [ADMIN_DISPLAY_NAME=...] pnpm admin:bootstrap
 *
 * There is no default password. The password is read from the environment (never from argv, where it
 * would be visible in process listings) and is never printed. An existing account is never modified.
 */
import { hash } from '@node-rs/argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { validateEnvironment } from '../src/config/environment';
import { PrismaClient } from '../src/generated/prisma/client';

async function main(): Promise<void> {
  const environment = validateEnvironment(process.env);
  const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? '';
  const displayName = (process.env.ADMIN_DISPLAY_NAME ?? 'Administrator').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error('ADMIN_EMAIL must be a valid email address');
  }
  if (password.length < 12 || password.length > 256) {
    throw new Error('ADMIN_PASSWORD must be 12-256 characters');
  }
  if (displayName.length < 1 || displayName.length > 80) {
    throw new Error('ADMIN_DISPLAY_NAME must be 1-80 characters');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: environment.DATABASE_URL }),
  });
  try {
    if ((await prisma.user.findUnique({ where: { email } })) !== null) {
      throw new Error('An account with this email already exists; nothing was changed');
    }
    const passwordHash = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
    await prisma.user.create({
      data: { email, displayName, passwordHash, role: 'ADMIN', isActive: true },
    });
    console.log(`Administrator created: ${email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Bootstrap failed');
  process.exit(1);
});
