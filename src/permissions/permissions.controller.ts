// permissions.controller.ts
import { Controller, Post, Param, Body, Get, BadRequestException } from '@nestjs/common';
import { PermissionService } from './permissions.service';

@Controller('permission')
export class PermissionController {
    constructor(private readonly permissionService: PermissionService) {}
    
    @Post('create')
    async createPermission(
        @Body('name') name: string,
        @Body('description') description?: string,
        @Body('label') label?: string,
    ) {
        if (!name) throw new BadRequestException('Permission name is required');
        return this.permissionService.createPermission(name, description, label);
    }
    
    
    @Post('assign/:userId')
    async assignPermission(
        @Param('userId') userId: number,
        @Body() changes: {
            id?: number;      // ①  you can send id …
            granted: boolean; // ③  true = add, false = remove
        }[],    ) {
            return this.permissionService.assignPermissionToUser(userId, changes);
        }

        @Post('assign-by-name/:userId/:permissionName')
        async assignPermissionByName(
            @Param('userId') userId: number,
            @Param('permissionName') permissionName: string,
        ) {
            return this.permissionService.assignPermissionByName(userId, permissionName);
        }
        
        @Get('user/:userId')
        async getUserPermissions(@Param('userId') userId: number) {
            return this.permissionService.getUserPermissions(userId);
        }
        @Get('/')
        async getPermissions() {
            return this.permissionService.getPermissions();
        }
        
    }
    