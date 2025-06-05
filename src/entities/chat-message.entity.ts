import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Client } from './client.entity';
import { User } from './user.entity';
import { LoanRequest } from './loan-request.entity';

@Entity()
export class ChatMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  content: string;

  @Column()
  direction: 'INCOMING' | 'OUTGOING';

  @ManyToOne(() => Client, (client) => client.chatMessages)
  @JoinColumn({ name: 'clientId' })
  client: Client;

  @ManyToOne(() => User, (user) => user.chatMessages, { nullable: true })
  @JoinColumn({ name: 'agentId' })
  agent: User;

  @ManyToOne(() => LoanRequest, (loanRequest) => loanRequest.chatMessages, { nullable: true })
  @JoinColumn({ name: 'loanRequestId' })
  loanRequest: LoanRequest;

  @CreateDateColumn()
  createdAt: Date;
}
