import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService
  ) {}

  async validateUserAndGenerateToken(
    document: string,
    password: string
  ): Promise<[string, string] | null> {
    const user = await this.usersService.findByDocument(document);

    // Compare plain password (or use bcrypt.compare if hashed)
    if (!user || user.password !== password) {
      return null;
    }
    user.password = ""
    const token = await this.jwtService.signAsync(
      { user: user },
      { expiresIn: '15m' }
    );

    return [token, user.role];
  }
}
