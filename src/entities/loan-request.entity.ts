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
  documents: Document[]; // ✅ already present

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
  repaymentAccount?: PaymentAccount;          // ✅ NEW FIELD

  /* ──────── Monetary values ────────── */
  @Column('decimal', { precision: 10, scale: 2 })
  amount: number;                             // Final disbursed amount

  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  requestedAmount: number;                    // Amount originally requested

  /* ─────────── Status & meta ───────── */
  @Column({ type: 'text' })
  status: LoanRequestStatus;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  /* ─────────── Optional info ───────── */
  @Column({ type: 'text', nullable: true })
  type: string;                               // e.g. “MENSUAL”, “QUINCENAL”

  @Column({ type: 'text', nullable: true })
  mode: string;                               // Any extra mode descriptor

  @Column({ type: 'int', nullable: true })
  mora: number;                               // Days in arrears

  @Column({ type: 'date', nullable: true })
  endDateAt: Date;                            // Expected pay-off date

  @Column({ default: false })
  isRenewed: boolean;                         // Flag for renewed loans

  @Column({ type: 'date', nullable: true })
  renewedAt?: Date;                           // Renewal timestamp

  @Column({ type: 'text', nullable: true })
  paymentDay?: string;                        // “15-30”, “5-20”, etc.
}
