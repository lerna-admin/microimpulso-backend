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
  TRANSFERENCIA = 'TRANSFERENCIA',
}


@Entity()
export class CashMovement {
  @PrimaryGeneratedColumn()
  id: number;

  /* ────────────────────────────── Relations ───────────────────────────── */
  @ManyToOne(() => Branch)
  @JoinColumn({ name: 'branchId' })
  branch: Branch;
  @Column()                 // ← FK explícita
  branchId: number;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'adminId' })
  admin: User;
  @Column({ nullable: true })
  adminId: number;

  @ManyToOne(() => LoanTransaction, { nullable: true })
  @JoinColumn({ name: 'transactionId' })
  transaction?: LoanTransaction;

  /* ─────────────────────────────── Fields ─────────────────────────────── */
  @Column({ type: 'text' })
  type: CashMovementType;

  @Column({ type: 'text' })
  category: CashMovementCategory;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ type: 'text', nullable: true })
  reference?: string;

  /* ───────────────────────────── Timestamp ──────────────────────────────
   * - SQLite: store local Bogotá time with DATETIME('now','localtime').
   * - Other engines: rely on CURRENT_TIMESTAMP and server TZ (typically UTC).
   * - Transformer always returns the value in America/Bogota.
   * --------------------------------------------------------------------- */
 @CreateDateColumn({
    type: 'datetime',
    default: () => "DATETIME('now','localtime')",
  })
  createdAt: Date;

  @Column({ nullable: true })
  origenId?: number;

  @Column({ nullable: true })
  destinoId?: number;

  @Column({ type: 'boolean', default: false })
  isTransferMirror?: boolean;
}
