import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Client } from './client.entity';

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
}
