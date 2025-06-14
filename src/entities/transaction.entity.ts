import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  JoinColumn,
} from 'typeorm';
import { LoanRequest } from './loan-request.entity';

export enum TransactionType {
  DISBURSEMENT = 'disbursement',
  REPAYMENT = 'repayment',
  PENALTY = 'penalty',
  ADJUSTMENT = 'adjustment',
}

@Entity()
export class LoanTransaction {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => LoanRequest, loan => loan.transactions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'loanRequestId' }) 
  loanRequest: LoanRequest;


  @Column({ type: 'text', enum: TransactionType })
  Transactiontype: TransactionType;

  @Column('decimal', { precision: 12, scale: 2 })
  amount: number;

 @CreateDateColumn({
  type: 'datetime',
  default: () => "DATETIME('now','localtime')",
})
date: Date;

  @Column({ nullable: true })
  reference?: string;

  @Column({ type: 'int', nullable: true })
  daysLate?: number;
}
