import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsModule } from './clients/clients.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { LoanRequestModule } from './loan-request/loan-request.module';
import { ChatModule } from './chat/chat.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { TransactionModule } from './transaction.module';
import { DocumentModule } from './document/document.module';
import { TransactionsModule } from './transactions/transactions.module';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'sqlite',
      database: 'database.sqlite',
      entities: [__dirname + '/**/*.entity{.ts,.js}'],
      synchronize: true,
    }),
    ClientsModule,
    AuthModule,
    UsersModule,
    LoanRequestModule,
    ChatModule,
    TransactionModule,
    DocumentModule,
    TransactionsModule,
  ],
  controllers: [ChatController],
  providers: [ChatService],
})
export class AppModule {}
