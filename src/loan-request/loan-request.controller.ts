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
    
    // all filters come in as strings (even numbers/dates), parse below
    @Query('id')               id?: string,
    @Query('amount')           amount?: string,
    @Query('requestedAmount')  requestedAmount?: string,
    @Query('status')           status?: LoanRequestStatus,
    @Query('type')             type?: string,
    @Query('mode')             mode?: string,       // ISO date
    @Query('mora')             mora?: string,
    @Query('endDateAt')        endDateAt?: string,  // ISO date
    @Query('paymentDay')       paymentDay?: string,
    @Query('createdAt')        createdAt?: string,  // ISO datetime
    @Query('updatedAt')        updatedAt?: string,  // ISO datetime
    @Query('clientId')         clientId?: string,
    @Query('agentId')          agentId?: string,
  ): Promise<{
    data: LoanRequest[];
    totalItems: number;
    totalPages: number;
    page: number;
    limit: number;
  }> {
    // build filters only when present
    const filters: Record<string, any> = {};
    if (id)               filters.id               = parseInt(id, 10);
    if (amount)           filters.amount           = parseFloat(amount);
    if (requestedAmount)  filters.requestedAmount  = parseFloat(requestedAmount);
    if (status)           filters.status           = status;
    if (type)             filters.type             = type;
    if (mode)             filters.mode             = new Date(mode);
    if (mora)             filters.mora             = parseInt(mora, 10);
    if (endDateAt)        filters.endDateAt        = new Date(endDateAt);
    if (paymentDay)       filters.paymentDay       = paymentDay;
    if (createdAt)        filters.createdAt        = new Date(createdAt);
    if (updatedAt)        filters.updatedAt        = new Date(updatedAt);
    if (clientId)         filters.clientId         = parseInt(clientId, 10);
    if (agentId)          filters.agentId          = parseInt(agentId, 10);
    
    return this.loanRequestService.findAll(limit, page, filters);
  }
  
  @Get('agent/:id')
  async findByAgent(
    @Param('id', ParseIntPipe) agentId: number,
    
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe)
    limit: number,
    
    @Query('page', new DefaultValuePipe(1), ParseIntPipe)
    page: number,
    
    // all optional filters as strings:
    @Query('id')               id?: string,
    @Query('amount')           amount?: string,
    @Query('requestedAmount')  requestedAmount?: string,
    @Query('status')           status?: LoanRequestStatus,
    @Query('type')             type?: string,
    @Query('mode')             mode?: string,        // ISO date string
    @Query('mora')             mora?: string,
    @Query('endDateAt')        endDateAt?: string,   // ISO date string
    @Query('paymentDay')       paymentDay?: string,
    @Query('createdAt')        createdAt?: string,   // ISO datetime string
    @Query('updatedAt')        updatedAt?: string,   // ISO datetime string
    @Query('clientId')         clientId?: string,
  ): Promise<{
    data: LoanRequest[];
    totalItems: number;
    totalPages: number;
    page: number;
    limit: number;
  }> {
    // parse and assemble filters only when provided
    const filters: Record<string, any> = {};
    if (id)              filters.id               = parseInt(id, 10);
    if (amount)          filters.amount           = parseFloat(amount);
    if (requestedAmount) filters.requestedAmount  = parseFloat(requestedAmount);
    if (status)          filters.status           = status;
    if (type)            filters.type             = type;
    if (mode)            filters.mode             = new Date(mode);
    if (mora)            filters.mora             = parseInt(mora, 10);
    if (endDateAt)       filters.endDateAt        = new Date(endDateAt);
    if (paymentDay)      filters.paymentDay       = paymentDay;
    if (createdAt)       filters.createdAt        = new Date(createdAt);
    if (updatedAt)       filters.updatedAt        = new Date(updatedAt);
    if (clientId)        filters.clientId         = parseInt(clientId, 10);
    
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
