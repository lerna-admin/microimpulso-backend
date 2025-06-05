import {
  Controller,
  Post,
  Get,
  Body,
  Param,
} from '@nestjs/common';
import { TransactionsService } from './transactions.service';

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  // Crear nueva transacción
  @Post()
  create(@Body() body: any) {
    return this.transactionsService.create(body);
  }

  // Consultar transacciones por ID de préstamo
  @Get('loan/:loanRequestId')
  findByLoanRequest(@Param('loanRequestId') loanRequestId: string) {
    return this.transactionsService.findAllByLoanRequest(loanRequestId);
  }
}
