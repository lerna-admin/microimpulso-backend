import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { User } from '../entities/user.entity';
import { Permission } from 'src/entities/permissions.entity';
import { Branch } from 'src/entities/branch.entity';
import { Country } from 'src/entities/country.entity';
@Module({
  imports: [TypeOrmModule.forFeature([User, Permission, Branch , Country])], // ✅ Esta línea es obligatoria
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
