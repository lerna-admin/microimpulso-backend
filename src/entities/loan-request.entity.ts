import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';
import { Client } from './client.entity';
import { User } from './user.entity';
import { ChatMessage } from './chat-message.entity';
import { LoanTransaction } from './transaction.entity';
import { Document } from './document.entity';

export enum LoanRequestStatus {
  NEW = 'new',
  UNDER_REVIEW = 'under_review',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  CANCELED = 'canceled',
  COMPLETED = 'completed',
  FUNDED = 'funded'
}

@Entity()
export class LoanRequest {
  @PrimaryGeneratedColumn()
  id: number;
  
  @OneToMany(() => ChatMessage, (msg) => msg.loanRequest)
  chatMessages: ChatMessage[];
  
  @OneToMany(() => LoanTransaction, txn => txn.loanRequest, {
    cascade: true,
  })
  transactions: LoanTransaction[];
  
  @OneToMany(() => Document, doc => doc.loanRequest, {
    cascade: true,
  })
  documents: Document[]; // ✅ NUEVO
  
  @Column('decimal', { precision: 10, scale: 2 })
  amount: number;
  
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  requestedAmount: number;
  
  @Column({
    type: 'text',
  })
  status: LoanRequestStatus;
  
  @ManyToOne(() => Client, (client) => client.loanRequests)
  @JoinColumn({ name: 'clientId' })
  client: Client;
  
  @ManyToOne(() => User, (user) => user.loanRequests)
  @JoinColumn({ name: 'agentId' })
  agent: User;
  
  @CreateDateColumn()
  createdAt: Date;
  
  @UpdateDateColumn()
  updatedAt: Date;
  
  @Column({
    type: 'text',
    nullable: true,
  })
  type: string;
  
  @Column({
    type: 'text',
    nullable: true,
  })
  mode: string;
  
  @Column({
    type: 'int',
    nullable: true,
  })
  mora: number;
  
  @Column({
    type: 'date',
    nullable: true,
  })
  endDateAt: Date;
  
  @Column({ default: false })
  isRenewed: boolean;
  
  @Column({ type: 'date', nullable: true })
  renewedAt?: Date;
  
  @Column({ type: 'text', nullable: true })
  paymentDay?: string;
}
