import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { User } from '../entities/user.entity';
import { Permission } from 'src/entities/permissions.entity';
import { Branch } from 'src/entities/branch.entity';
@Module({
  imports: [TypeOrmModule.forFeature([User, Permission, Branch])], // ✅ Esta línea es obligatoria
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
