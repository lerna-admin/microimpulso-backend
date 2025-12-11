import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Client } from './client.entity';
import { LoanRequest } from './loan-request.entity'; // ← Importar LoanRequest

export enum DocumentType {
  ID = 'ID', // Cédula
  WORK_LETTER = 'WORK_LETTER', // Carta laboral
  UTILITY_BILL = 'UTILITY_BILL', // Recibo
  PAYMENT_DETAIL = 'PAYMENT_DETAIL', // Desprendible de pago
  CONTRACT_SIGNED = 'CONTRACT_SIGNED', // Contrato firmado
  SELFIE = 'SELFIE', // Selfie de validación
  OTHER = 'OTHER', // Otro documento
}

@Entity()
export class Document {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Client, (client) => client.documents)
  @JoinColumn({ name: 'clientId' })
  client: Client;

  @ManyToOne(() => LoanRequest, (loan) => loan.documents, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'loanRequestId' })
  loanRequest: LoanRequest; // ✅ Nueva relación con LoanRequest

  @Column()
  type: string;

  @Column()
  url: string;

  @CreateDateColumn()
  createdAt: Date;

  @Column({
    type: 'simple-enum',
    enum: DocumentType,
    nullable: true, // para permitir que inicialmente esté sin clasificar
  })
  classification: DocumentType;
}
