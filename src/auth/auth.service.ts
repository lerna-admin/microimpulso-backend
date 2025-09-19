import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import * as bcrypt from 'bcrypt';
import { ClosingService } from '../agent-closing/agent-closing.service';
import { User, UserStatus } from '../entities/user.entity'; // ⬅️ add this


@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly agentClosingService: ClosingService
  ) {}


 /**
   * Validates the user by document and password, and generates a JWT token.
   * Rules:
   *  - BLOCKED users cannot log in even with correct credentials.
   *  - Wrong password increments failedLoginAttempts; on 3rd failure → set status=BLOCKED (regardless of previous status).
   *  - Successful login (when not BLOCKED) resets failedLoginAttempts to 0.
   */
  async validateUserAndGenerateToken(
    document: string,
    password: string
  ): Promise<{ token: string; role: string; branch: any; closedRoute: boolean; permission: any } | null> {
    const user = await this.usersService.findByDocument(document);
    if (!user) return null; // do not leak enumeration info

    // If BLOCKED (or INACTIVE, if you keep this restriction), deny login immediately.
    if (user.status === UserStatus.BLOCKED || user.status === UserStatus.INACTIVE) {
      return null;
    }

    // Password check (prefer bcrypt if hash-like; else legacy strict equality)
    const looksHashed = typeof user.password === 'string' && /^\$2[aby]\$/.test(user.password);
    let passwordOk = false;
    try {
      passwordOk = looksHashed ? await bcrypt.compare(password, user.password) : user.password === password;
    } catch {
      passwordOk = false;
    }

    if (!passwordOk) {
      // Wrong password → increase counter and block on threshold (3)
      const current = user.failedLoginAttempts ?? 0;
      const next = current + 1;
      const MAX_FAILED = 3;

      const updates: Partial<User> = { failedLoginAttempts: next };
      if (next >= MAX_FAILED) {
        // Force BLOCKED regardless of previous status, per your requirement
        updates.status = UserStatus.BLOCKED;
      }

      await this.usersService.update(user.id, updates);
      return null;
    }

    // Correct password:
    // Re-check: even with correct password, a BLOCKED user must NOT pass (paranoia guard).
    if (user.status !== UserStatus.ACTIVE) {
      return null;
    }


    // Reset failed attempts on successful login (only if not BLOCKED)
    if ((user.failedLoginAttempts ?? 0) > 0) {
      await this.usersService.update(user.id, { failedLoginAttempts: 0 } as Partial<User>);
    }

    // Daily closing check
    const closedRoute = await this.agentClosingService.hasClosedToday(user.id);

    // Remove password before signing
    user.password = '';

    // Short-lived token (15 minutes)
    const token = await this.jwtService.signAsync({ user }, { expiresIn: '15m' });

    return {
      token,
      role: user.role,
      branch: user.branch,
      closedRoute,
      permission: user.permissions,
    };
  }
}