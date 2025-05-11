import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, OneToMany } from 'typeorm';
import { Client } from './client.entity';
import { User } from './user.entity';
import { ChatMessage } from './chat-message.entity';

export enum LoanRequestStatus {
  NEW = 'new',
  UNDER_REVIEW = 'under_review',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  CANCELED = 'canceled',
  COMPLETED = 'completed'
}

@Entity()
export class LoanRequest {
  @PrimaryGeneratedColumn()
  id: number;

  
  @OneToMany(() => ChatMessage, (msg) => msg.loanRequest)
chatMessages: ChatMessage[];


  @Column('decimal', { precision: 10, scale: 2 })
  amount: number;

  @Column({
    type: 'text', // Store the enum as simple text
  })
  status: LoanRequestStatus;

  @ManyToOne(() => Client, (client) => client.loanRequests)
  @JoinColumn({ name: 'clientId' })
  client: Client;

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  @ManyToOne(() => User, (user) => user.loanRequests)
  @JoinColumn({ name: 'agentId' })
  agent: User;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
