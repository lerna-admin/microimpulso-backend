// notifications.controller.ts
import { Controller, Get, Post, Param, Query, Req, HttpCode } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  async get(@Req() req, @Query('since') since: string) {
    const userId = req.user.id;
    return this.service.findSince(userId, since);
  }

  @Post(':id/read')
  @HttpCode(204)
  async read(@Param('id') id: number) {
    await this.service.markAsRead(id);
  }
}
