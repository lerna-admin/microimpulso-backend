// permission.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Permission } from 'src/entities/permissions.entity';
import { User } from 'src/entities/user.entity';

@Injectable()
export class PermissionService {
  constructor(
    @InjectRepository(Permission)
    private readonly permissionRepository: Repository<Permission>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async createPermission(name: string) {
    // Create and save a new permission
    const perm = this.permissionRepository.create({ name });
    return this.permissionRepository.save(perm);
  }

  async assignPermissionByName(userId: number, permissionName: string) {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['permissions'],
    });
    if (!user) throw new Error('User not found');

    const permission = await this.permissionRepository.findOne({ where: { name: permissionName } });
    if (!permission) throw new Error('Permission not found');

    // Evitar duplicados
    if (user.permissions.some(p => p.name === permissionName)) return user;

    user.permissions = [...(user.permissions || []), permission];
    return this.userRepository.save(user);
  }

  async assignPermissionToUser(userId: number, permissionId: number) {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['permissions'],
    });
    if (!user) throw new Error('User not found');

    const permission = await this.permissionRepository.findOne({ where: { id: permissionId } });
    if (!permission) throw new Error('Permission not found');

    user.permissions = [...(user.permissions || []), permission];
    return this.userRepository.save(user);
  }

  async getUserPermissions(userId: number) {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['permissions'],
    });
    return user?.permissions ?? [];
  }
  async getPermissions() {
    const permissions = await this.permissionRepository.find();
    return permissions ?? [];
  }

}
