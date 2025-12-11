import { DataSource } from 'typeorm';
import { User } from '../entities/user.entity';
import { Client } from '../entities/client.entity';
import { LoanRequest } from '../entities/loan-request.entity';
import { Document } from '../entities/document.entity';
import { ChatMessage } from '../entities/chat-message.entity';
import { CashFlow } from '../entities/cash-flow.entity';

export const AppDataSource = new DataSource({
  type: 'mysql',
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  username: process.env.DB_USER || 'microimpulso_user',
  password: process.env.DB_PASS || 'MiAppDb#2025',
  database: process.env.DB_NAME || 'microimpulso_app',
  synchronize: false,
  logging: true,
  charset: 'utf8mb4_unicode_ci',
  entities: [User, Client, LoanRequest, Document, ChatMessage, CashFlow],
});
