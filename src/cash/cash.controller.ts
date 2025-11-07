import {
    Controller,
    Post,
    Body,
    Get,
    Query,
    BadRequestException,
    ParseIntPipe,
    Param,
    Delete,
    DefaultValuePipe,
    ParseBoolPipe,
    Res,
} from '@nestjs/common';
import { CashService } from './cash.service';
import { Response } from 'express';

@Controller('cash')
export class CashController {
    constructor(private readonly cashService: CashService) { }
    
    /** Register a manual movement */
    @Post()
    async registerMovement(@Body() body: any) {
        const { typeMovement, amount, category, description, branchId, userId, origenId, destinoId } = body;
        console.log('BODY RECIBIDO:', body);
        console.log("SI ES")
        
        // Validar tipo de movimiento
        if (typeof typeMovement !== 'string') {
            throw new BadRequestException('typeMovement must be a string');
        }
        
        if (!['ENTRADA', 'SALIDA', 'TRANSFERENCIA'].includes(typeMovement)) {
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
            branchId,
            origenId,
            destinoId
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
    
    @Get('daily')
    async daily(
        @Query('userId', ParseIntPipe) userId: number,
        @Query('date') date: string,
    ) {
        return this.cashService.getDailyTotalsByUser(userId, date);
    }
    @Get('daily-trace/by-user/:userId')
    async getDailyTraceByUserController(
        @Param('userId') userId: number,
        @Query('date') date?: string, // 'YYYY-MM-DD'
    ) {
        const target = date ?? new Date().toISOString().slice(0, 10);
        return this.cashService.getDailyTraceByUser(userId, target);
    }
    /**
    * Elimina un movimiento de caja.
    * Si el movimiento tiene una LoanTransaction asociada y nadie más la referencia,
    * la elimina también.
    * Extra: si es TRANSFERENCIA, puedes eliminar el movimiento "par" con ?pair=true
    */
    @Delete(':id')
    async deleteMovement(
        @Param('id', ParseIntPipe) id: number,
        @Query('pair', new DefaultValuePipe(false), ParseBoolPipe) pair: boolean,
    ) {
        return this.cashService.deleteMovement(id, { deletePair: pair });
    }
    
    
    /**
    * GET /cash/export-daily-trace?userId=1&date=2025-10-27&format=excel|pdf&filename=opcional
    * Devuelve un .xlsx o .pdf con la traza diaria (misma data que getDailyTraceByUser).
    */
    
    @Get('export-daily-trace')
    async exportDailyTrace(
        @Query('userId', ParseIntPipe) userId: number,
        @Query('date') date: string,
        @Query('format') format: 'excel' | 'pdf' = 'excel',
        @Res() res: Response,
        @Query('filename') filename?: string,
        // puedes dejarlo por si luego lo usas, pero no lo mandamos al service
        @Query('detailed') detailed?: string,
    ) {
        if (!date) throw new BadRequestException('date (YYYY-MM-DD) es requerido');
        
        const baseName = (filename?.trim() || `traza_${userId}_${date}`).replace(/[^a-zA-Z0-9_-]/g, '');
        
        if (format === 'pdf') {
            // 👇 el service actual SOLO recibe (userId, date)
            const pdf = await this.cashService.exportDailyTraceToPDF(userId, date);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${baseName}.pdf"`);
            return res.end(pdf);
        }
        
        const xlsx = await this.cashService.exportDailyTraceToExcel(userId, date);
        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.xlsx"`);
        return res.end(xlsx);
    }
    
    /**
    * GET /cash/export-statistics?userId=1&date=2025-10-27&filename=opcional
    * Exporta un Excel EN ESPAÑOL con:
    *  - Hoja "Indicadores" (KPIs como getDailyTotalsByUser)
    *  - Hoja "Préstamos" (detalle por préstamo)
    *  - Hoja "Resumen"   (totales de cartera activa)
    */
    @Get('export-statistics')
    async exportIndicadoresYPrestamos(
        @Query('userId', ParseIntPipe) userId: number,
        @Query('date') date: string,
        @Res() res: Response,
        @Query('filename') filename?: string,
    ) {
        if (!date) throw new BadRequestException('date (YYYY-MM-DD) es requerido');
        
        const baseName = (filename?.trim() || `indicadores_prestamos_${userId}_${date}`).replace(
            /[^a-zA-Z0-9_-]/g,
            '',
        );
        
        const xlsx = await this.cashService.exportarPrestamosEIndicadoresPorUsuarioAExcel(
            userId,
            date,
        );
        
        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.xlsx"`);
        return res.end(xlsx);
    }
    
}