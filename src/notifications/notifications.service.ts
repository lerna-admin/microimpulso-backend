// notifications.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { Notification } from './notifications.entity';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification)
    private readonly repo: Repository<Notification>,
  ) {}

  async create(recipientId: number, category: string, type: string, payload?: any) {
    const notif = this.repo.create({ recipientId, category, type, payload });
    return this.repo.save(notif);
  }

  async findSince(recipientId: number, since?: string) {
    const whereClause = since
      ? { recipientId, createdAt: MoreThan(new Date(since)) }
      : { recipientId };

    return this.repo.find({
      where: whereClause,
      order: { createdAt: 'ASC' },
    });
  }

  async markAsRead(id: number) {
    await this.repo.update(id, { isRead: true });
  }
}