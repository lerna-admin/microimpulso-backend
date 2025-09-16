import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  JoinColumn,
  ManyToOne,
  JoinTable,
  ManyToMany,
} from 'typeorm';
import { Client } from './client.entity';
import { ChatMessage } from './chat-message.entity';
import { CashFlow } from './cash-flow.entity';
import { LoanRequest } from './loan-request.entity';
import { Branch } from './branch.entity';
import { Permission } from './permissions.entity';

/**
 * Enum for user roles
 */
export enum UserRole {
  AGENT = 'AGENT',
  ADMINISTRATOR = 'ADMIN',
  MANAGER = 'MANAGER',
}

/**
 * Enum for user status
 */
export enum UserStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  BLOCKED = 'BLOCKED',
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

  @Column({ type: 'text' })
  role: UserRole;

  /** @brief Overall account status (ACTIVE, INACTIVE, BLOCKED). Defaults to ACTIVE. */
  @Column({ type: 'text', default: UserStatus.ACTIVE })
  status: UserStatus;

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

  /**
   * Relation to administrator (self-relation)
   */
  @ManyToOne(() => User, (user) => user.subordinates, { nullable: true })
  @JoinColumn({ name: 'adminId' })
  administrator: User;

  @Column({ nullable: true })
  adminId: number;

  /**
   * Reverse side: administrator has many subordinates
   */
  @OneToMany(() => User, (user) => user.administrator)
  subordinates: User[];

  @ManyToOne(() => Branch, (branch) => branch.agents, { nullable: true })
  @JoinColumn({ name: 'branchId' })
  branch: Branch;

  @Column({ nullable: true })
  branchId: number;

  @ManyToMany(() => Permission, { eager: true })
  @JoinTable()
  permissions: Permission[];
}
