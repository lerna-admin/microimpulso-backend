import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Branch } from '../entities/branch.entity';
import { User }   from '../entities/user.entity';

export type AccountOwner = 'BRANCH' | 'AGENT';

@Entity()
export class PaymentAccount {
  @PrimaryGeneratedColumn()
  id: number;

  /* ───── Basic data ───── */
  @Column()
  bankName: string;                      // e.g. "Bancolombia"

  @Column()
  accountNumber: string;                 // e.g. "123-456-789"

  @Column()
  accountType: string;                   // "Savings" | "Checking"

  @Column({ default: 'COP' })
  currency: string;                      // ISO code

  /* ───── Limit control ───── */
  @Column('decimal', { precision: 16, scale: 2, default: 0 })
  limit: number;                         // Max amount this account can receive (period configurable)

  @Column('decimal', { precision: 16, scale: 2, default: 0 })
  dailyReceived: number;                 // Running total for “today”

  /* ───── Status flags ───── */
  @Column({ default: true })
  isActive: boolean;

  @Column({ default: false })
  isPrimary: boolean;

  /* ───── Holder info ───── */
  @Column()
  holderName: string;                    // Account holder’s full name

  @Column()
  holderDocument: string;                // Colombian CC / NIT / Passport


  /* ───── Timestamps ───── */
  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
