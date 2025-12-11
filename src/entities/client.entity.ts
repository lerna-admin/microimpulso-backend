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
import { Country } from './country.entity';

const jsonArrayTransformer = {
  to(value?: Array<{ key: string; type: 'text' | 'number' | 'link'; value: any }>) {
    try {
      return JSON.stringify(Array.isArray(value) ? value : []);
    } catch {
      return '[]';
    }
  },
  from(value?: string) {
    try {
      const parsed = JSON.parse(value || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  },
};

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

  @Column({ type: 'text', nullable: true })
  address: string;

  // 👇 NUEVO: dirección alterna
  @Column({ type: 'text', nullable: true })
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
  @Column({ nullable: true })
  city?: string;
    
  @Column({
    type: 'text',              // ✅ válido en SQLite y Postgres
    nullable: true,
    default: '[]',             // por si la DB crea la fila sin valor
    transformer: jsonArrayTransformer,
  })
  customFields: Array<{ key: string; type: 'text'|'number'|'link'; value: any }>;

  @ManyToOne(() => Country, c => c.branches, {
  nullable: true,            // <── permitir null temporalmente
  onDelete: 'SET NULL',
})
@JoinColumn({ name: 'countryId' })
country: Country;

}
