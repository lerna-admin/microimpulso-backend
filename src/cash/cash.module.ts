import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { CashMovement } from "src/entities/cash-movement.entity";
import { CashController } from "./cash.controller";
import { CashService } from "./cash.service";

// src/cash/cash.module.ts
@Module({
  imports: [TypeOrmModule.forFeature([CashMovement])],
  controllers: [CashController],
  providers: [CashService],
})
export class CashModule {}
