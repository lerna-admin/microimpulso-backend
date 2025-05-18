import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Client } from './client.entity';

export enum DocumentType {
  ID = 'ID', // Cédula
  WORK_LETTER = 'WORK_LETTER', // Carta laboral
  UTILITY_BILL = 'UTILITY_BILL', // Recibo
  PAYMENT_DETAIL  = 'PAYMENT_DETAIL', //Desprendible de pago
  OTHER = 'OTHER', // Otro documento
}

@Entity()
export class Document {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Client, (client) => client.documents)
  @JoinColumn({ name: 'clientId' })
  client: Client;

  @Column()
  type: string;

  @Column()
  url: string;

  @CreateDateColumn()
  createdAt: Date;

  @Column({
    type: 'varchar',
    enum: DocumentType,
    nullable: true, // para permitir que inicialmente esté sin clasificar
  })
  classification: DocumentType;
}
