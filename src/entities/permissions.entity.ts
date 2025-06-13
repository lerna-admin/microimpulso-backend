import { Entity, PrimaryGeneratedColumn, Column, ManyToMany } from 'typeorm';
import { User } from './user.entity';

@Entity()
export class Permission {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  name: string; // Example: 'CAN_DISBURSE'

  @Column({ nullable: true })
  description?: string; // Optional: Human-readable description

  @ManyToMany(() => User, (user) => user.permissions)
  users: User[];
}
