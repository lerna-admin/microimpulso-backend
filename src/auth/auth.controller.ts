import { Controller, Post, Body, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  async login(@Body() body: { document: string; password: string }) {
    const { document, password } = body;

    if (!document || !password) {
      throw new BadRequestException('Document and password are required');
    }

    const result = await this.authService.validateUserAndGenerateToken(document, password);

    if (!result) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const [token] = result;
    return { token };
  }
}
