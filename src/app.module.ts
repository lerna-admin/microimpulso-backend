import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsModule } from './clients/clients.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { LoanRequestModule } from './loan-request/loan-request.module';
import { ChatModule } from './chat/chat.module';
import { ChatController } from './chat.controller';
import { TransactionModule } from './transaction.module';
import { DocumentModule } from './document/document.module';
import { TransactionsModule } from './transactions/transactions.module';
import { ChatService } from './chat/chat.service';
import { AnalyticsModule } from './analytics/analytics.module';
import { ClosingModule } from './agent-closing/agent-closing.module';
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
    AnalyticsModule,
    ClosingModule
  ],
  controllers: [ChatController],
})
export class AppModule {}
