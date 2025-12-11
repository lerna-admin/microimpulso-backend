// notifications.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'recipient_id' })
  recipientId: number;

  @Column({ length: 50 })
  category: string;

  @Column({ length: 50 })
  type: string;

  // Use simple-json for compatibility with SQLite and Postgres
  @Column({ type: 'simple-json', nullable: true })
  payload: Record<string, any>;

  @Column({ name: 'is_read', default: false })
  isRead: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;

  @Column({ length: 500, nullable: true })
  description: string;

}
