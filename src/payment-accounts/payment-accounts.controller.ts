import {
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Param,
    Query,
    Body,
    ParseIntPipe,
    BadRequestException,
  } from '@nestjs/common';
  import { PaymentAccountService } from './payment-account.service';
  
  @Controller('payment-accounts')
  export class PaymentAccountController {
    constructor(private readonly svc: PaymentAccountService) {}
  
    /** GET /payment-accounts?active=true|false */
    @Get()
    list(@Query('active') active?: string) {
      return this.svc.findAll(active);
    }
  
    /** POST /payment-accounts */
    @Post()
    create(@Body() payload: any) {
      return this.svc.create(payload);   // payload is plain JSON
    }
  
    /** PUT /payment-accounts/:id */
    @Put(':id')
    update(
      @Param('id', ParseIntPipe) id: number,
      @Body() payload: any,
    ) {
      return this.svc.update(id, payload);
    }
  
    /** DELETE /payment-accounts/:id (soft-delete) */
    @Delete(':id')
    remove(@Param('id', ParseIntPipe) id: number) {
      return this.svc.remove(id);
    }
  
    /** GET /payment-accounts/pick?amount=123000 */
    @Get('pick')
    async pick(@Query('amount', ParseIntPipe) amount: number) {
      if (!amount || amount <= 0) {
        throw new BadRequestException('Amount must be a positive number');
      }
      return this.svc.pickAccountFor(amount);
    }
  }
  