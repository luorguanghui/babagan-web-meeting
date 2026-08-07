import argon2 from 'argon2';

import { domainError } from '../domain/errors.js';

export interface PasswordHasher {
  hash(value: string): Promise<string>;
  verify(hash: string, value: string): Promise<boolean>;
}

/**
 * 64 MiB * five simultaneous verifications is a 320 MiB memory upper bound,
 * leaving substantial headroom on the 2 GiB API host.
 */
export class Argon2PasswordHasher implements PasswordHasher {
  static readonly memoryCostKiB = 65_536;

  async hash(value: string): Promise<string> {
    return argon2.hash(value, {
      type: argon2.argon2id,
      memoryCost: Argon2PasswordHasher.memoryCostKiB,
      timeCost: 3,
      parallelism: 1
    });
  }

  async verify(hash: string, value: string): Promise<boolean> {
    if (!hash.startsWith('$argon2id$')) {
      await this.verifyDummy(value);
      return false;
    }

    try {
      return await argon2.verify(hash, value);
    } catch {
      await this.verifyDummy(value);
      return false;
    }
  }

  private async verifyDummy(value: string): Promise<void> {
    await argon2.verify(dummyArgon2idHash, value);
  }
}

const dummyArgon2idHash = '$argon2id$v=19$m=65536,t=3,p=1$0ukYSW6oWvR8weZcfrLfqg$ukoVl/zgHlZZmu5GjGENUBGVRK0k0q5Dsdj08NZwXpQ';

export async function authenticateMeetingPassword(
  passwords: PasswordHasher,
  passwordHash: string,
  suppliedPassword: string | undefined
): Promise<void> {
  // Always perform one Argon2 verification for a protected meeting, even when
  // the password field is absent, to keep the public failure behavior uniform.
  const verified = await passwords.verify(passwordHash, suppliedPassword ?? '');
  if (suppliedPassword === undefined || !verified) {
    throw domainError('INVALID_MEETING_PASSWORD');
  }
}
