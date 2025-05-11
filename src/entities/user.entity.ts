import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { Client } from './client.entity';
import { ChatMessage } from './chat-message.entity';
import { CashFlow } from './cash-flow.entity';
import { LoanRequest } from './loan-request.entity';

/**
 * Enum for user roles
 */
export enum UserRole {
  AGENT = 'AGENT',
  ADMINISTRATOR = 'ADMINISTRATOR',
  MANAGER = 'MANAGER',
}

/**
 * User entity definition
 */
@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column({ unique: true })
  email: string;

  @Column({ unique: true, nullable: true })
  document: string;

  @Column()
  password: string;

  @Column({
    type: 'text',
  })
  role: UserRole;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  /**
   * One agent can handle many clients
   */
  @OneToMany(() => Client, (client) => client.agent)
  clients: Client[];

  /**
   * One agent can send many chat messages
   */
  @OneToMany(() => ChatMessage, (chatMessage) => chatMessage.agent)
  chatMessages: ChatMessage[];

  /**
   * One user can register many cash flow operations
   */
  @OneToMany(() => CashFlow, (cashFlow) => cashFlow.user)
  cashFlows: CashFlow[];

  /**
   * One agent can be assigned to many loan requests
   */
  @OneToMany(() => LoanRequest, (loanRequest) => loanRequest.agent)
  loanRequests: LoanRequest[];
}
