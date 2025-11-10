import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';

import { ClientsModule } from './clients/clients.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { LoanRequestModule } from './loan-request/loan-request.module';
import { ChatModule } from './chat/chat.module';
import { DocumentModule } from './document/document.module';
import { TransactionsModule } from './transactions/transactions.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ClosingModule } from './agent-closing/agent-closing.module';
import { CashModule } from './cash/cash.module';
import { PermissionModule } from './permissions/permissions.module';
import { CampaignModule } from './campaign/campaign.module';
import { BranchModule } from './branch/branch.module';
import { PaymentAccountModule } from './payment-accounts/payment-account.module';
import { ConfigParamModule } from './config-param/config-param.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ReportsModule } from './reports/reports.module';
import { CountriesModule } from './country/coumtry.module';

@Module({
  imports: [
    // ⬇️ Carga .env y expone ConfigService globalmente
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'], // ajusta si tu .env está en otra ruta
    }),

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
    DocumentModule,
    TransactionsModule,
    AnalyticsModule,
    ClosingModule,
    CashModule,
    PermissionModule,
    CampaignModule,
    BranchModule,
    ConfigParamModule,
    PaymentAccountModule,
    NotificationsModule,
    ReportsModule,
    CountriesModule
  ],
})
export class AppModule {}
