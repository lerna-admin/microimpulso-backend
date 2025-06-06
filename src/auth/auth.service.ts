import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import * as bcrypt from 'bcrypt';
import { ClosingService } from '../agent-closing/agent-closing.service'; // Asegúrate de importar esto

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly agentClosingService: ClosingService
  ) {}

  async validateUserAndGenerateToken(
    document: string,
    password: string
  ): Promise<{ token: string; role: string; closedRoute: boolean } | null> {
    const user = await this.usersService.findByDocument(document);

    // Validación de contraseña (ajusta según uso de bcrypt)
    if (!user || user.password !== password) {
      return null;
    }

    // Chequear si ya cerró ruta hoy
    const closedRoute = await this.agentClosingService.hasClosedToday(user.id);

    // Remueve password por seguridad
    user.password = '';

    const token = await this.jwtService.signAsync(
      { user },
      { expiresIn: '15m' }
    );

    return {
      token,
      role: user.role,
      closedRoute,
    };
  }
}
