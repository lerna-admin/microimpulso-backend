import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  JoinColumn,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
} from 'typeorm';
import { Campaign } from './campaign.entity';
import { Client } from './client.entity';
@Entity()
export class CampaignContact {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Campaign, (campaign) => campaign.contacts, { onDelete: 'CASCADE' })
  campaign: Campaign;

  @ManyToOne(() => Client, { nullable: true })
  client: Client;

  @Column('text')
  ttsScript: string;

  @Column({ default: 'pending' })
  callStatus: 'pending' | 'in_progress' | 'completed' | 'failed';

  @Column({ nullable: true })
  attemptedAt: Date;

  @Column({ nullable: true })
  result: string;
}
