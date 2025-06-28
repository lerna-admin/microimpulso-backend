// notifications.controller.ts
import { Controller, Get, Post, Param, Query, Req, HttpCode, ParseIntPipe } from '@nestjs/common';
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
  @Get(':userId')
  async getUnread(
    @Param('userId', ParseIntPipe) userId: number,
    @Query('since') since?: string,
  ) {
    // If you still want to filter by "since", pass it along; otherwise omit the query arg
    return this.service.findUnreadByUser(userId, since);
  }

}
