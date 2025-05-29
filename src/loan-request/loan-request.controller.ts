import { Controller, Get, Post, Body, Patch, Param, NotFoundException, Query, DefaultValuePipe, ParseIntPipe } from '@nestjs/common';
import { LoanRequestService } from './loan-request.service';
import { CreateLoanRequestDto } from './dto/create-loan-request.dto';
import { LoanRequest, LoanRequestStatus } from 'src/entities/loan-request.entity';
import { ChatService } from 'src/chat/chat.service';

@Controller('loan-request')
export class LoanRequestController {
  constructor(private readonly loanRequestService: LoanRequestService, private readonly chatService :  ChatService) {}

  @Post()
  create(@Body() createLoanRequestDto: CreateLoanRequestDto) {
    return this.loanRequestService.create(createLoanRequestDto);
  }

@Get()
  async findAll(
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page: number,

    // all LoanRequest fields as optional filters:
    @Query('id',               ParseIntPipe)               id?: number,
    @Query('amount')                                   amount?: string,  // decimal as string
    @Query('requestedAmount')                         requestedAmount?: string,
    @Query('status')                                  status?: LoanRequestStatus,
    @Query('type')                                    type?: string,
    @Query('mode')                                    mode?: string,    // ISO date string
    @Query('mora',             ParseIntPipe)           mora?: number,
    @Query('endDateAt')                               endDateAt?: string,
    @Query('paymentDay')                              paymentDay?: string,
    @Query('createdAt')                               createdAt?: string,
    @Query('updatedAt')                               updatedAt?: string,
    @Query('clientId',         ParseIntPipe)           clientId?: number,
    @Query('agentId',          ParseIntPipe)           agentId?: number,
  ): Promise<{
    data: LoanRequest[];
    totalItems: number;
    totalPages: number;
    page: number;
    limit: number;
  }> {
    // build up a filters object exactly matching service signature
    const filters: Record<string, any> = {
      id,
      amount,
      requestedAmount,
      status,
      type,
      mode: mode ? new Date(mode) : undefined,
      mora,
      endDateAt: endDateAt ? new Date(endDateAt) : undefined,
      paymentDay,
      createdAt: createdAt ? new Date(createdAt) : undefined,
      updatedAt: updatedAt ? new Date(updatedAt) : undefined,
      clientId,
      agentId,
    };

    return this.loanRequestService.findAll(limit, page, filters);
  }
@Get('agent/:id')
  async findByAgent(
    @Param('id', ParseIntPipe) agentId: number,

    @Query('limit', new DefaultValuePipe(10), ParseIntPipe)
    limit: number,

    @Query('page', new DefaultValuePipe(1), ParseIntPipe)
    page: number,

    // all LoanRequest fields (except agentId, since it's the path param):
    @Query('id', ParseIntPipe) id?: number,
    @Query('amount') amount?: string,
    @Query('requestedAmount') requestedAmount?: string,
    @Query('status') status?: LoanRequestStatus,
    @Query('type') type?: string,
    @Query('mode') mode?: string,         // ISO date string
    @Query('mora', ParseIntPipe) mora?: number,
    @Query('endDateAt') endDateAt?: string,
    @Query('paymentDay') paymentDay?: string,
    @Query('createdAt') createdAt?: string,
    @Query('updatedAt') updatedAt?: string,
    @Query('clientId', ParseIntPipe) clientId?: number,
  ): Promise<{
    data: LoanRequest[];
    totalItems: number;
    totalPages: number;
    page: number;
    limit: number;
  }> {
    // assemble inline filters exactly matching entity columns:
    const filters: Record<string, any> = {
      id,
      amount: amount !== undefined ? parseFloat(amount) : undefined,
      requestedAmount:
        requestedAmount !== undefined
          ? parseFloat(requestedAmount)
          : undefined,
      status,
      type,
      mode: mode ? new Date(mode) : undefined,
      mora,
      endDateAt: endDateAt ? new Date(endDateAt) : undefined,
      paymentDay,
      createdAt: createdAt ? new Date(createdAt) : undefined,
      updatedAt: updatedAt ? new Date(updatedAt) : undefined,
      clientId,
    };

    return this.loanRequestService.findAllByAgent(
      agentId,
      limit,
      page,
      filters,
    );
  }

  @Get(':id')
  findOne(@Param('id') id: number) {
    return this.loanRequestService.findById(id);
  }

  @Patch(':id')
  update(@Param('id') id: number, @Body() data: Partial<LoanRequest>) {
    return this.loanRequestService.update(id, data);
  }

    
  @Post(':id/send-contract')
  async sendContract(@Param('id') id: number) {
    return this.chatService.sendContractToClient(id);
  }
  
  
  
  
}
