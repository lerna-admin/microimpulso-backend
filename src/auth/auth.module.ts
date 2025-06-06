import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { UsersModule } from '../users/users.module'; 
import { ClosingModule } from 'src/agent-closing/agent-closing.module';

@Module({
  imports: [
    JwtModule.register({
      secret: 'pandora', // ⚠️ Usa env variable en producción
      signOptions: { expiresIn: '15m' },
    }),
    UsersModule, 
    ClosingModule
  ],
  providers: [AuthService, JwtStrategy],
  controllers: [AuthController],
})
export class AuthModule {}
