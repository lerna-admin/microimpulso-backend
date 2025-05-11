import { DataSource } from 'typeorm';
import { User } from '../entities/user.entity';
import { Client } from '../entities/client.entity';
import { LoanRequest } from '../entities/loan-request.entity';
import { Document } from '../entities/document.entity';
import { ChatMessage } from '../entities/chat-message.entity';
import { CashFlow } from '../entities/cash-flow.entity';

export const AppDataSource = new DataSource({
  type: 'sqlite',
  database: 'database.sqlite',
  synchronize: true,
  logging: true,
  entities: [User, Client, LoanRequest, Document, ChatMessage, CashFlow],
});
