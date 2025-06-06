import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import * as bcrypt from 'bcrypt';
import { ClosingService } from '../agent-closing/agent-closing.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly agentClosingService: ClosingService
  ) {}

  /**
   * Validates the user by document and password, and generates a JWT token.
   * Also checks if the agent has already submitted the daily closing.
   */
  async validateUserAndGenerateToken(
    document: string,
    password: string
  ): Promise<{ token: string; role: string; closedRoute: boolean } | null> {
    const user = await this.usersService.findByDocument(document);

    // Basic password validation (replace with bcrypt.compare if using hashes)
    if (!user || user.password !== password) {
      return null;
    }

    // Check if the user has already submitted a closing today
    const closedRoute = await this.agentClosingService.hasClosedToday(user.id);

    // Remove password before embedding user into token payload
    user.password = '';

    // Generate JWT token with user payload (expires in 15 minutes)
    const token = await this.jwtService.signAsync(
      { user },
      { expiresIn: '15m' }
    );

    // Return token, user role, and closing status
    return {
      token,
      role: user.role,
      closedRoute,
    };
  }
}
