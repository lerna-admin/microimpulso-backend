import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, UpdateDateColumn } from 'typeorm';

@Entity()
export class PaymentAccount {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  bankName: string;                      // "Bancolombia"

  @Column()
  accountNumber: string;                 // "123-456-789"

  @Column()
  accountType: string;                   // "Savings" | "Checking"

  @Column({ default: 'COP' })
  currency: string;                      // ISO code

  /* --- limit control --- */
  @Column('decimal', { precision: 16, scale: 2, default: 0 })
  limit: number;                    // max amount this acct can receive / day

  @Column('decimal', { precision: 16, scale: 2, default: 0 })
  dailyReceived: number;                 // running total for “today”

  @Column({ default: true })
  isActive: boolean;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ default: false })
  isPrimary: boolean;   
  
  /* --- holder info --- */
  @Column()
  holderName: string;                    // Account holder’s full name

  @Column()
  holderDocument: string;                // e.g. Colombian CC / NIT
}
