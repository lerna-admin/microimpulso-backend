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
    
    async assignPermissionToUser(
        userId: number,
        changes: { id?: number; granted: boolean }[],
    ) {
        /* ── 1️⃣  Load user with current permissions ── */
        const user = await this.userRepository.findOne({
            where: { id: userId },
            relations: ['permissions'],
        });
        if (!user) throw new Error('User not found');
        
        /* ── 2️⃣  Build quick-lookup sets for “has” and “wants” ── */
        const currentIds = new Set(user.permissions.map(p => p.id));
        
        /* Collect all ids / names requested so we can fetch once */
        const reqIds   = changes.filter(c => c.id).map(c => c.id);
        
        const perms = await this.permissionRepository.find({
            where: [
                ...(reqIds.length   ? [{ id:   In(reqIds) }]   : [])
            ],
        });
        
        /* Map for quick access */
        const permById   = new Map(perms.map(p => [p.id, p]));
        
        /* ── 3️⃣  Apply each change ── */
        for (const c of changes) {
            const perm =
            c.id   !== undefined ? permById.get(c.id) :
            undefined;
            
            if (!perm) continue;                        // unknown permission → ignore
            
            if (c.granted && !currentIds.has(perm.id)) {
                user.permissions.push(perm);             // add
                currentIds.add(perm.id);
            }
            if (!c.granted && currentIds.has(perm.id)) {
                user.permissions = user.permissions.filter(p => p.id !== perm.id); // remove
                currentIds.delete(perm.id);
            }
        }
        
        /* ── 4️⃣  Save & return ── */
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
