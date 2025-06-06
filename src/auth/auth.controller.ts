import { Controller, Post, Body, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  async login(@Body() body: { document: string; password: string }) {
    const { document, password } = body;

    // Validate input presence
    if (!document || !password) {
      throw new BadRequestException('Document and password are required');
    }

    // Attempt to validate user and generate token
    const result = await this.authService.validateUserAndGenerateToken(document, password);

    // If credentials are invalid, reject request
    if (!result) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Return token, user role, and closing status
    return result;
  }
}
