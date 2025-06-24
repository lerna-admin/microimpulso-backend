import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentAccount } from './payment-account.entity';
import { PaymentAccountService } from './payment-account.service';
import { PaymentAccountController } from './payment-accounts.controller';

@Module({
  imports: [TypeOrmModule.forFeature([PaymentAccount])],
  controllers: [PaymentAccountController],
  providers: [PaymentAccountService],
  exports: [PaymentAccountService],
})
export class PaymentAccountModule {}
