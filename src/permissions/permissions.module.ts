// permission.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Permission } from 'src/entities/permissions.entity';
import { User } from 'src/entities/user.entity';
import { PermissionService } from './permissions.service';
import { PermissionController } from './permissions.controller';
import { UserModule } from 'src/entities/user.module';

@Module({
  imports: [TypeOrmModule.forFeature([Permission, User]), UserModule],
  providers: [PermissionService],
  controllers: [PermissionController],
  exports: [PermissionService],
})
export class PermissionModule {}
