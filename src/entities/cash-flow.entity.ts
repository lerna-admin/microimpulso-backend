import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { User } from './user.entity';

export enum CashFlowType {
  INCOME = 'INCOME',
  EXPENSE = 'EXPENSE',
}

@Entity()
export class CashFlow {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, (user) => user.cashFlows)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({
    type: 'text',
  })
  type: CashFlowType;
  

  @Column('decimal', { precision: 10, scale: 2 })
  amount: number;

  @Column('text', { nullable: true })
  description: string;

  @CreateDateColumn()
  createdAt: Date;
}
