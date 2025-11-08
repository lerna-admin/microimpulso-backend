import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  JoinColumn,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
} from 'typeorm';
import { User } from './user.entity';
import { Country } from './country.entity';
@Entity()
export class Branch {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  /** País de la sede en ISO-2 (p. ej. 'CO', 'CR') */
  @Column({ length: 2, nullable: true })
  countryIso2?: string;

@ManyToOne(() => Country, c => c.branches, {
  nullable: true,            // <── permitir null temporalmente
  onDelete: 'SET NULL',
})
@JoinColumn({ name: 'countryId' })
country: Country;

@Column({ type: 'int', nullable: true }) // <── permitir null temporalmente
countryId: number;

  /** Indicativo telefónico del país que atiende esta sede (p. ej. '57', '506') */
  @Column({ length: 6, nullable: true })
  phoneCountryCode?: string;

  /** Si esta sede acepta chats entrantes del país configurado */
  @Column({ default: true })
  acceptsInbound: boolean;

  @OneToOne(() => User, { nullable: true })
  @JoinColumn()
  administrator: User;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => User, (user) => user.branch)
  agents: User[];
}
