import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { User } from '../entities/user.entity';
import { Permission } from 'src/entities/permissions.entity';
@Module({
  imports: [TypeOrmModule.forFeature([User, Permission])], // ✅ Esta línea es obligatoria
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
