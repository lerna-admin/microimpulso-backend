import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { LoanTransaction } from './transaction.entity';
import { User } from './user.entity';
import { Branch } from './branch.entity';
import { CashMovementCategory } from './cash-movement-category.enum';

export enum CashMovementType {
  ENTRADA = 'ENTRADA',
  SALIDA = 'SALIDA',
}

@Entity()
export class CashMovement {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Branch)
  @JoinColumn({ name: 'branchId' })
  branch: Branch;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'adminId' })
  admin: User;

  @Column({ type: 'text' }) // cambio aquí
  type: CashMovementType;

  @Column({ type: 'text' }) // cambio aquí
  category: CashMovementCategory;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ type: 'text', nullable: true })
  reference?: string;

  @ManyToOne(() => LoanTransaction, { nullable: true })
  @JoinColumn({ name: 'transactionId' })
  transaction?: LoanTransaction;

  @CreateDateColumn()
  createdAt: Date;
}

