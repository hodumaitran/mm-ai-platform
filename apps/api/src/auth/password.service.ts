import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

// OWASP-recommended Argon2id parameters; the library default algorithm is Argon2id.
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordService {
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return hash(password, OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /** Spend the same work for unknown accounts so response time does not reveal them. */
  async verifyAgainstDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash('mm-ai-dummy-password-not-a-credential');
    await this.verify(await this.dummyHash, password);
  }
}
