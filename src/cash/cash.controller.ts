import {
    Controller,
    Post,
    Body,
    Get,
    Query,
    BadRequestException,
} from '@nestjs/common';
import { CashService } from './cash.service';

@Controller('cash')
export class CashController {
    constructor(private readonly cashService: CashService) { }

    /** Register a manual movement */
    @Post()
    async registerMovement(@Body() body: any) {
        const { typeMovement, amount, category, description, branchId, userId } = body;
        console.log('BODY RECIBIDO:', body);
        console.log("SI ES")

        // Validar tipo de movimiento
        if (typeof typeMovement !== 'string') {
            throw new BadRequestException('typeMovement must be a string');
        }

        if (!['ENTRADA', 'SALIDA'].includes(typeMovement)) {
            throw new BadRequestException('typeMovement must be either "ENTRADA" or "SALIDA"');
        }

        // Validar amount
        if (amount === undefined || amount === null) {
            throw new BadRequestException('amount is required');
        }

        if (typeof amount !== 'number') {
            throw new BadRequestException('amount must be a number');
        }

        if (isNaN(amount) || amount <= 0) {
            throw new BadRequestException('amount must be a number greater than 0');
        }

        // Validar categoría
        if (typeof category !== 'string') {
            throw new BadRequestException('category must be a string');
        }

        if (!category.trim()) {
            throw new BadRequestException('category cannot be empty');
        }

        

        return this.cashService.registerMovement({
            typeMovement: typeMovement,
            amount,
            category,
            reference: description,
            userId,
            branchId
        });
    }

    /** Paginated list of movements with optional search */
    @Get()
    async getMovements(
        @Query('branchId') branchId: number,
        @Query('limit') limit: number = 10,
        @Query('page') page: number = 1,
        @Query('search') search?: string,
        @Query('date') date?: string,
    ) {
        if (!branchId || isNaN(Number(branchId))) {
            throw new BadRequestException('branchId is required and must be a valid number');
        }

        return this.cashService.getMovements(Number(branchId), limit, page, search, date);
    }

    /** Daily cash summary (totals) */
    @Get('summary')
    async getSummary(
        @Query('date') date: string,
        @Query('branchId') branchId: number,
    ) {
        if (!branchId) {
            throw new BadRequestException('branchId is required');
        }

        const parsedDate = date;
        return this.cashService.getDailyTotals(branchId, parsedDate);
    }

}
