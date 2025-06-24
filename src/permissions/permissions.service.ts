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
        /* ── 1️⃣  Load user with current permissions ─────────────────────── */
        const user = await this.userRepository.findOne({
        where: { id: userId },
        relations: ['permissions'],
        });
        if (!user) throw new Error('User not found');
    
        /* ── 2️⃣  Collect desired ids / names (arrays, ES5-safe) ─────────── */
        const wantIdList: number[]   = [];
        const wantNameList: string[] = [];
    
        changes.forEach(c => {
        if (!c.granted) return;          // ignore false flags
        if (c.id   !== undefined) wantIdList.push(c.id);
        if (c.name !== undefined) wantNameList.push(c.name);
        });
    
        /* ── 3️⃣  Fetch all referenced permissions in one query ──────────── */
        const perms = await this.permissionRepository.find({
        where: [
            ...(wantIdList.length   ? [{ id:   In(wantIdList) }]   : []),
            ...(wantNameList.length ? [{ name: In(wantNameList) }] : []),
        ],
        });
    
        const wantedIds = new Set(perms.map(p => p.id));   // Set ok for lookup
    
        /* ── 4️⃣  Re-assign: keep only wanted, then add missing ones ─────── */
        user.permissions = user.permissions.filter(p => wantedIds.has(p.id));
    
        perms.forEach(p => {
        if (!user.permissions.some(up => up.id === p.id)) {
            user.permissions.push(p);
        }
        });
    
        /* ── 5️⃣  Persist & return ───────────────────────────────────────── */
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
