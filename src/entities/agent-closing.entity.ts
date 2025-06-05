import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { User } from "./user.entity";

@Entity()
export class AgentClosing {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'agentId' })
  agent: User;

  @Column({ type: 'datetime' })
  closedAt: Date;

  @Column('decimal', { precision: 14, scale: 2, nullable: true })
  cartera?: number;

  @Column('decimal', { precision: 14, scale: 2, nullable: true })
  cobrado?: number;

  @Column({ type: 'int', nullable: true })
  renovados?: number;

  @Column({ type: 'int', nullable: true })
  nuevos?: number;

  @Column({ type: 'text', nullable: true })
  resumenJson?: string;
}
