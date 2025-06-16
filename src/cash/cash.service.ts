import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CashMovement, CashMovementType } from 'src/entities/cash-movement.entity';
import { CashMovementCategory } from 'src/entities/cash-movement-category.enum';
import { Between, ILike, Repository } from 'typeorm';
import { LessThan } from 'typeorm';
import { startOfDay, endOfDay, parseISO } from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { AgentClosing } from 'src/entities/agent-closing.entity';
import { LoanRequest } from 'src/entities/loan-request.entity';
import { LoanTransaction, TransactionType } from 'src/entities/transaction.entity';
import { format } from 'date-fns';

function getLocalDayRange(rawDate: string | Date): { start: Date; end: Date } {
    const date = typeof rawDate === 'string' ? new Date(rawDate) : rawDate;
    
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);
    
    return { start, end };
}

@Injectable()
export class CashService {
    constructor(
        @InjectRepository(CashMovement)
        private readonly cashRepo: Repository<CashMovement>,
        @InjectRepository(AgentClosing)
        private readonly closingRepo: Repository<AgentClosing>,
        @InjectRepository(LoanTransaction)
        private readonly loanTransactionRepo: Repository<LoanTransaction>,
        
    ) { }
    
    
    /** Register one manual movement */
    async registerMovement(data: any): Promise<CashMovement> {
        // Prevent array input
        if (Array.isArray(data)) {
            throw new BadRequestException('Array input is not supported for this endpoint');
        }
        
        const {
            typeMovement,
            amount,
            category,
            reference,
            adminId,
            branchId,
            transactionId,
        } = data;
        
        // Validate typeMovement
        if (typeof typeMovement !== 'string') {
            throw new BadRequestException('typeMovement must be a string');
        }
        
        if (!['ENTRADA', 'SALIDA'].includes(typeMovement)) {
            throw new BadRequestException('typeMovement must be "ENTRADA" or "SALIDA"');
        }
        
        // Validate amount
        if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) {
            throw new BadRequestException('amount must be a number greater than 0');
        }
        
        // Validate category
        if (typeof category !== 'string' || !category.trim()) {
            throw new BadRequestException('category must be a non-empty string');
        }
        
        
        
        // Construct the cash movement entity
        const partialMovement: Partial<CashMovement> = {
            type: typeMovement as CashMovementType,
            amount,
            category: category as CashMovementCategory,
            reference,
            adminId,
            branchId,
            transaction: transactionId ? ({ id: transactionId } as any) : undefined,
        };
        
        const movement = this.cashRepo.create(partialMovement);
        
        // Save to the database
        return this.cashRepo.save(movement);
    }
    
    
    
    /** Paginated and filtered list of movements */
    async getMovements(
        branchId: number,
        limit: number,
        page: number,
        search?: string,
        date?: string,
    ) {
        const query = this.cashRepo
        .createQueryBuilder('movement')
        .where('movement.branchId = :branchId', { branchId });
        
        if (search && typeof search === 'string') {
            query.andWhere('LOWER(movement.reference) LIKE :search', {
                search: `%${search.toLowerCase()}%`,
            });
        }
        
        /* ───── Date filter (optional) ───── */
        if (date) {
            const day =
            typeof date === 'string'
            ? date                   // ‘2025-06-14’
            : format(date, 'yyyy-MM-dd');
            
            // — SQLite
            // DATE(col) descarta la parte de la hora y mantiene AAAA-MM-DD
            query.andWhere('DATE(movement.createdAt) = :day', { day });
            
        }
        
        
        query
        .orderBy('movement.createdAt', 'DESC')
        .skip((page - 1) * limit)
        .take(limit);
        
        const [data, total] = await query.getManyAndCount();
        
        return {
            data: data.map((m) => ({
                id: m.id,
                category: m.category,
                amount: m.amount,
                createdAt: m.createdAt,
                description: m.reference,
            })),
            total,
            page,
            limit,
        };
    }
    
    
    
    /**
    * Returns the cash/KPI dashboard for a branch on a given date.
    * “Renovados” and “Nuevos” are computed on-the-fly from DISBURSEMENT
    * transactions, using requestedAmount for value KPIs plus a count KPI.
    */
    async getDailyTotals(branchId: number, rawDate: Date | string) {
        /* ───── 1. Build [start, end] as local dates ───── */
        let start: Date;
        if (typeof rawDate === 'string') {
            // rawDate format: 'YYYY-MM-DD'
            const [y, m, d] = rawDate.split('-').map(Number);
            start = new Date(y, m - 1, d, 0, 0, 0, 0);           // 00:00 local
        } else {
            // Already a Date ⇒ clamp to 00:00
            start = new Date(rawDate);
            start.setHours(0, 0, 0, 0);
        }
        
        // End of the same local day
        const end = new Date(start);
        end.setHours(23, 59, 59, 999);
        
        /* ───── 2. Movements (cash) ───── */
        const [movements, previousMovements] = await Promise.all([
            this.cashRepo.find({
                where: {
                    branch: { id: branchId },
                    createdAt: Between(start, end),     // movements for the day
                },
            }),
            this.cashRepo.find({
                where: {
                    branch: { id: branchId },
                    createdAt: LessThan(start),         // history before the day
                },
            }),
        ]);
        
        /* ───── 3. Opening cash ───── */
        const cajaAnterior = previousMovements.reduce((tot, m) => {
            const amt = +m.amount;
            return m.type === 'ENTRADA' ? tot + amt : tot - amt;
        }, 0);
        
        /* ───── 4. Net for the day ───── */
        const totalEntradas = movements
        .filter((m) => m.type === 'ENTRADA')
        .reduce((s, m) => s + +m.amount, 0);
        
        const totalSalidas = movements
        .filter((m) => m.type === 'SALIDA')
        .reduce((s, m) => s + +m.amount, 0);
        
        const cajaReal = cajaAnterior + totalEntradas - totalSalidas;
        
        /* ───── 5. Category breakdown ───── */
        const byCategory = (cat: string) =>
            movements
        .filter((m) => m.category === cat)
        .reduce((s, m) => s + +m.amount, 0);
        
        const entraCaja        = byCategory('ENTRADA_GERENCIA');
        const totalCobros      = byCategory('COBRO_CLIENTE');
        const totalDesembolsos = byCategory('PRESTAMO');
        const totalGastos      = byCategory('GASTO_PROVEEDOR');
        
        /* ───── 6. KPIs ───── */
        const disbursements = await this.loanTransactionRepo.find({
            where: {
                Transactiontype: TransactionType.DISBURSEMENT,
                date: Between(start, end),
                loanRequest: { agent: { branch: { id: branchId } } },
            },
            relations: { loanRequest: { client: true, agent: { branch: true } } },
        });
        
        
        const penalties = await this.loanTransactionRepo.find({
            where: {
                Transactiontype: TransactionType.PENALTY,
                date: Between(start, end),
                loanRequest: {
                    agent: {
                        branch: {
                            id: branchId,
                        },
                    },
                },
            },
            relations: {
                loanRequest: {
                    client: true,
                    agent: {
                        branch: true,
                    },
                },
            },
        });
        
        
        
        /* Build unique renewed requests for today */
        const renewedByRequest = new Map<number, LoanRequest>();
        for (const pen of penalties) {
            const req = pen.loanRequest as LoanRequest;
            if (!renewedByRequest.has(req.id)) {
                renewedByRequest.set(req.id, req);
            }
        }
        
        const totalRenovados = [...renewedByRequest.values()].reduce(
            (sum, req) => sum + +(req.requestedAmount ?? req.amount ?? 0),
            0,
        );
        
        
        
        const countRenovados = renewedByRequest.size;
        
        const nuevosHoy = movements.filter(
            (m) => m.type === 'SALIDA' && m.category === 'PRESTAMO'
        );
        
        const totalNuevos = nuevosHoy.reduce((sum, m) => sum + +m.amount, 0);
        const countNuevos = nuevosHoy.length;
        
        
        
        /* ───── 7. Final dashboard ───── */
        return [
            { label: 'Caja anterior', value: cajaAnterior,   trend: '' },
            { label: 'Entra caja',    value: entraCaja,      trend: 'increase' },
            { label: 'Cobro',         value: totalCobros,    trend: 'increase' },
            { label: 'Préstamos',     value: totalDesembolsos, trend: 'decrease' },
            { label: 'Gastos',        value: totalGastos,    trend: 'decrease' },
            { label: 'Caja real',     value: cajaReal,       trend: '' },
            
            { label: 'Renovados', value: totalRenovados, trend: 'increase', amount:countRenovados },
            
            { label: 'Nuevos', value: totalNuevos,    trend: 'increase', amount: countNuevos },
        ];
    }
}
