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
import { toZonedTime } from 'date-fns-tz';


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

  /* Timestamp (stored local for SQLite, UTC elsewhere) -------------- */
  @CreateDateColumn({
    // Use SQLite-specific syntax in dev, generic in prod
    type:
      process.env.DB_TYPE === 'sqlite' ? 'datetime' : 'timestamptz',
    default: () =>
      process.env.DB_TYPE === 'sqlite'
        ? "DATETIME('now','localtime')" // Bogotá time when using SQLite
        : 'CURRENT_TIMESTAMP',          // relies on server TZ for other DBs
    transformer: {
      // keep raw value when persisting
      to: (value: Date) => value,
      // convert DB value to America/Bogota on fetch
      from: (value: Date | string) => {
        const tz = 'America/Bogota';
        const dateObj =
          typeof value === 'string' ? new Date(value) : value;
        return toZonedTime(dateObj, tz);
      },
    },
  })
  createdAt: Date;
}

