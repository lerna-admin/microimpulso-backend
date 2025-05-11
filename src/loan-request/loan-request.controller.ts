import { Controller, Get, Post, Body, Patch, Param } from '@nestjs/common';
import { LoanRequestService } from './loan-request.service';
import { CreateLoanRequestDto } from './dto/create-loan-request.dto';
import { LoanRequest } from 'src/entities/loan-request.entity';

@Controller('loan-request')
export class LoanRequestController {
  constructor(private readonly loanRequestService: LoanRequestService) {}

  @Post()
  create(@Body() createLoanRequestDto: CreateLoanRequestDto) {
    return this.loanRequestService.create(createLoanRequestDto);
  }

  @Get()
  findAll(): Promise<LoanRequest[]> {
    return this.loanRequestService.findAll();
  }

  @Get('agent/:id')
  findByAgent(@Param('id') agentId: number): Promise<LoanRequest[]> {
    return this.loanRequestService.findAllByAgent(agentId);
  }

  @Get(':id')
  findOne(@Param('id') id: number) {
    return this.loanRequestService.findById(id);
  }

  @Patch(':id')
  update(@Param('id') id: number, @Body() data: Partial<LoanRequest>) {
    return this.loanRequestService.update(id, data);
  }
}
