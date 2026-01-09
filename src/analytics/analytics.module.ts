// analytics.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { LoanRequest } from 'src/entities/loan-request.entity';
import { LoanTransaction } from 'src/entities/transaction.entity';
import { User } from 'src/entities/user.entity';
import { Branch } from 'src/entities/branch.entity';
import { Country } from 'src/entities/country.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      LoanRequest,
      LoanTransaction,
      User,
      Branch,
      Country,
    ]),
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
