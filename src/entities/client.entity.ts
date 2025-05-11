import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';
import { LoanRequest } from './loan-request.entity';
import { Document } from './document.entity';
import { ChatMessage } from './chat-message.entity';

export enum ClientStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  SUSPENDED = 'SUSPENDED',
  PROSPECT = 'PROSPECT',
}

@Entity()
export class Client {
  // ▶ Numeric, auto‑increment primary key
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column()
  phone: string;

  @Column({ nullable: true })
  email: string;

  // ▶ New fields
  @Column({ nullable: true })
  document: string; // e.g. national ID number

  @Column({ nullable: true })
  address: string;

  /**
   * Cumulative amount lent to the client.
   * IMPORTANT: keep this in sync with LoanRequest totals.
   *   – Option A: update it in a transaction every time you create/close a loan.
   *   – Option B: drop this column and expose it through a SQL view or a
   *     service method that sums `loanRequest.amount` on demand.
   */
  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    default: 0,
    name: 'totalLoanAmount',
  })
  totalLoanAmount: number;

  @Column({ type: 'text' })
  status: ClientStatus;

  @ManyToOne(() => User, (user) => user.clients)
  @JoinColumn({ name: 'agentId' })
  agent: User;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => LoanRequest, (loanRequest) => loanRequest.client)
  loanRequests: LoanRequest[];

  @OneToMany(() => Document, (document) => document.client)
  documents: Document[];

  @OneToMany(() => ChatMessage, (chatMessage) => chatMessage.client)
  chatMessages: ChatMessage[];
}
