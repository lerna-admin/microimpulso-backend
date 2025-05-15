import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';
import { LoanRequest } from './loan-request.entity';

export enum TransactionType {
  DISBURSEMENT = 'disbursement',
  REPAYMENT = 'repayment',
  PENALTY = 'penalty',
  ADJUSTMENT = 'adjustment',
}

@Entity()
export class Transaction {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => LoanRequest, loan => loan.transactions, {
    onDelete: 'CASCADE',
  })
  loanRequest: LoanRequest;

  @Column({ type: 'text', enum: TransactionType })
  Transactiontype: TransactionType;

  @Column('decimal', { precision: 12, scale: 2 })
  amount: number;

  @CreateDateColumn()
  date: Date;

  @Column({ nullable: true })
  reference?: string;

  @Column({ type: 'int', nullable: true })
  daysLate?: number;


}
