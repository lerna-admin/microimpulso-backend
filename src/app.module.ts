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

const typeOrmConfig = {
  type: 'mysql' as const,
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  username: process.env.DB_USER || 'microimpulso_user',
  password: process.env.DB_PASS || 'MiAppDb#2025',
  database: process.env.DB_NAME || 'microimpulso_app',
  entities: [__dirname + '/**/*.entity{.ts,.js}'],
  synchronize: false,
  charset: 'utf8mb4_unicode_ci',
};
console.log('[TypeORM] Config', {
  host: typeOrmConfig.host,
  port: typeOrmConfig.port,
  username: typeOrmConfig.username,
  database: typeOrmConfig.database,
  passwordLength: typeOrmConfig.password ? typeOrmConfig.password.length : 0,
});

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),

    TypeOrmModule.forRoot(typeOrmConfig),

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
