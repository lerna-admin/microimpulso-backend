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
import { User }   from './user.entity';
import { ChatMessage }     from './chat-message.entity';
import { LoanTransaction } from './transaction.entity';
import { Document }        from './document.entity';
import { PaymentAccount } from 'src/payment-accounts/payment-account.entity';

/* ─────────────────────────────────────
   Enum with every possible loan state
   ──────────────────────────────────── */
export enum LoanRequestStatus {
  NEW          = 'new',
  UNDER_REVIEW = 'under_review',
  APPROVED     = 'approved',
  REJECTED     = 'rejected',
  CANCELED     = 'canceled',
  COMPLETED    = 'completed',
  FUNDED       = 'funded',
  RENEWED      = 'renewed',
}

@Entity()
export class LoanRequest {
  /* ─────────── Identifiers ─────────── */
  @PrimaryGeneratedColumn()
  id: number;

  /* ─────────── Relations ──────────── */
  @OneToMany(() => ChatMessage, (msg) => msg.loanRequest)
  chatMessages: ChatMessage[];

  @OneToMany(() => LoanTransaction, (txn) => txn.loanRequest, {
    cascade: true,
  })
  transactions: LoanTransaction[];

  @OneToMany(() => Document, (doc) => doc.loanRequest, {
    cascade: true,
  })
  documents: Document[];

  @ManyToOne(() => Client, (client) => client.loanRequests)
  @JoinColumn({ name: 'clientId' })
  client: Client;

  @ManyToOne(() => User, (user) => user.loanRequests)
  @JoinColumn({ name: 'agentId' })
  agent: User;

  /*  Account where the client will send every repayment.
      This is the ONLY bank-account reference we keep here. */
  @ManyToOne(() => PaymentAccount, { nullable: true })
  @JoinColumn({ name: 'repaymentAccountId' })
  repaymentAccount?: PaymentAccount;

  /* ──────── Monetary values ────────── */
  @Column('decimal', { precision: 10, scale: 2 })
  amount: number;

  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  requestedAmount: number;

  /* ─────────── Status & meta ───────── */
  @Column({ type: 'text' })
  status: LoanRequestStatus;

  @CreateDateColumn({ type: 'datetime', default: () => "DATETIME('now','localtime')" })
  createdAt: Date;

  @UpdateDateColumn({
    type: 'datetime',
    default: () => "DATETIME('now','localtime')",
  })
  updatedAt: Date;

  /* ─────────── Optional info ───────── */
  @Column({ type: 'text', nullable: true })
  type: string;

  @Column({ type: 'text', nullable: true })
  mode: string;

  @Column({ type: 'int', nullable: true })
  mora: number;

  @Column({ type: 'date', nullable: true })
  endDateAt: Date;

  @Column({ default: false })
  isRenewed: boolean;

  @Column({ type: 'date', nullable: true })
  renewedAt?: Date;

  @Column({ type: 'text', nullable: true })
  paymentDay?: string;

  @Column({ type: 'text', nullable: true })
  notes: string; // Guarda un JSON.stringify de tu arreglo de notas
}
