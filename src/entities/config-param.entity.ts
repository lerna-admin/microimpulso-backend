import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity()
export class ConfigParam {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  key: string;                           // e.g. "timezone" | "interestRate" | "defaultCurrency"

  @Column('text')
  value: string;                         // store as JSON.stringify(...) if complex

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}