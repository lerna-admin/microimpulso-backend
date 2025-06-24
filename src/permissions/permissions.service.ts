// permission.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, In, Repository } from 'typeorm';
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
    
    async createPermission(name: string, description?: string, label?: string) {
        const perm = this.permissionRepository.create({
            name,
            description,
            label,
        } as DeepPartial<Permission>);
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
    
    /**
     * Sync a user’s permissions so that ONLY the entries listed in `changes`
     * with `granted: true` remain assigned.
     */
    async assignPermissionToUser(
        userId: number,
        changes: { id?: number; name?: string; granted: boolean }[],
      ): Promise<User> {
        /* 1️⃣ load user ---------------------------------------------------- */
        const user = await this.userRepository.findOne({
          where: { id: userId },
          relations: ['permissions'],
        });
        if (!user) throw new Error('User not found');
      
        /* 2️⃣ collect only granted=true ----------------------------------- */
        const wantIds:   number[] = [];
        const wantNames: string[] = [];
        changes.forEach(c => {
          if (!c.granted) return;
          if (c.id   !== undefined) wantIds.push(c.id);
          if (c.name !== undefined) wantNames.push(c.name);
        });
      
        /* 3️⃣ if nothing is wanted → revoke everything and save ----------- */
        if (wantIds.length === 0 && wantNames.length === 0) {
          user.permissions = [];
          return this.userRepository.save(user);
        }
      
        /* 4️⃣ fetch only the requested permissions ------------------------ */
        const perms = await this.permissionRepository.find({
          where: [
            ...(wantIds.length   ? [{ id:   In(wantIds) }]   : []),
            ...(wantNames.length ? [{ name: In(wantNames) }] : []),
          ],
        });
      
        const wantedIds = new Set(perms.map(p => p.id));
      
        /* 5️⃣ rebuild the permission list --------------------------------- */
        user.permissions = user.permissions.filter(p => wantedIds.has(p.id));
        perms.forEach(p => {
          if (!user.permissions.some(up => up.id === p.id)) {
            user.permissions.push(p);
          }
        });
      
        /* 6️⃣ save & return ---------------------------------------------- */
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
