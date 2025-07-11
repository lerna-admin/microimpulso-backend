import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
    constructor(private readonly reports: ReportsService) {}
    
    @Get('daily-cash')
    async dailyCash(
        @Query('userId') userId: string,
        @Query('date') date?: string,
    ) {
        if (!userId) throw new BadRequestException('userId is required');
        return this.reports.getDailyCashSummary(userId, date);
    }
    
}
