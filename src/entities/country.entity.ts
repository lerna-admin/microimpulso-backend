import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from 'typeorm';
import { Branch } from './branch.entity';
import { Client } from './client.entity';
import { User } from './user.entity';

@Entity()
export class Country {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  code: string;   // "CO", "PE", etc.

  @Column()
  name: string;   // "Colombia", "Perú", etc.

  @OneToMany(() => Branch, b => b.country)
  branches: Branch[];

  @OneToMany(() => Client, c => c.country)
  clients: Client[];
  
  @OneToMany(() => User, (u) => u.managerCountry)
  managers: User[];
  
}
