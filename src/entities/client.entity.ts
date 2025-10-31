import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';
import { LoanRequest } from './loan-request.entity';
import { Document } from './document.entity';
import { ChatMessage } from './chat-message.entity';

export enum ClientStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  REJECTED = 'REJECTED',
  PROSPECT = 'PROSPECT',
}
@Entity()
export class Client {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column()
  phone: string;

  // 👇 NUEVO: teléfono alternativo
  @Column({ nullable: true })
  phone2?: string;

  @Column({ nullable: true })
  email: string;

  @Column({ nullable: true })
  document: string;

  @Column({ nullable: true })
  documentType: string;

  @Column({ nullable: true })
  address: string;

  // 👇 NUEVO: dirección alterna
  @Column({ nullable: true })
  address2?: string;

  // 👇 NUEVO: datos de referencia personal
  @Column({ nullable: true })
  referenceName?: string;

  @Column({ nullable: true })
  referencePhone?: string;

  @Column({ nullable: true })
  referenceRelationship?: string;

  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    default: 0,
    name: 'totalLoanAmount',
  })
  totalLoanAmount: number;

  @Column({ type: 'text' })
  status: ClientStatus;

  @ManyToOne(() => User, (user) => user.clients)
  @JoinColumn({ name: 'agentId' })
  agent: User;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => LoanRequest, (loanRequest) => loanRequest.client)
  loanRequests: LoanRequest[];

  @OneToMany(() => Document, (document) => document.client)
  documents: Document[];

  @OneToMany(() => ChatMessage, (chatMessage) => chatMessage.client)
  chatMessages: ChatMessage[];

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Column({ type: 'boolean', default: false })
  notEligible: boolean;

  @Column({ type: 'boolean', default: false })
  lead: boolean;
}
