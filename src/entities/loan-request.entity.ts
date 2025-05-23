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
import { Transaction } from './transaction.entity';
import { Document } from './document.entity'; // ✅ NUEVO

export enum LoanRequestStatus {
  NEW = 'new',
  UNDER_REVIEW = 'under_review',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  CANCELED = 'canceled',
  COMPLETED = 'completed',
}

@Entity()
export class LoanRequest {
  @PrimaryGeneratedColumn()
  id: number;

  @OneToMany(() => ChatMessage, (msg) => msg.loanRequest)
  chatMessages: ChatMessage[];

  @OneToMany(() => Transaction, txn => txn.loanRequest, {
    cascade: true,
  })
  transactions: Transaction[];

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
    type: 'date',
    nullable: true,
  })
  mode: Date;

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

  @Column({ type: 'text', nullable: true })
  paymentDay?: string;
}
