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
        
        // Validate admin and branch IDs
        if (!adminId || typeof adminId !== 'number') {
            throw new BadRequestException('adminId must be a valid number');
        }
        
        if (!branchId || typeof branchId !== 'number') {
            throw new BadRequestException('branchId must be a valid number');
        }
        
        // Construct the cash movement entity
        const partialMovement: Partial<CashMovement> = {
            type: typeMovement as CashMovementType,
            amount,
            category: category as CashMovementCategory,
            reference,
            admin: { id: adminId } as any,
            branch: { id: branchId } as any,
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
        
        if (date) {
            const startOfDay = new Date(date);
            startOfDay.setHours(0, 0, 0, 0);
            
            const endOfDay = new Date(date);
            endOfDay.setHours(23, 59, 59, 999);
            
            query.andWhere('movement.createdAt BETWEEN :start AND :end', {
                start: startOfDay.toISOString(),
                end: endOfDay.toISOString(),
            });
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
    * transactions, based on the requestedAmount field.
    */
    async getDailyTotals(branchId: number, rawDate: Date | string) {
        /* ───── 1. Build [start, end] in America/Bogota ───── */
        const tz = 'America/Bogota';
        const asDate = typeof rawDate === 'string' ? parseISO(rawDate) : rawDate;
        const zoned       = toZonedTime(asDate, tz);
        const zonedStart  = startOfDay(zoned);
        const zonedEnd    = endOfDay(zoned);
        const start = fromZonedTime(zonedStart, tz);
        const end   = fromZonedTime(zonedEnd,   tz);
        
        /* ───── 2. Movements (cash) ───── */
        const [movements, previousMovements] = await Promise.all([
            this.cashRepo.find({
                where: { branch: { id: branchId }, createdAt: Between(start, end) },
            }),
            this.cashRepo.find({
                where: { branch: { id: branchId }, createdAt: LessThan(start) },
            }),
        ]);
        
        /* ───── 3. Opening cash ───── */
        const cajaAnterior = previousMovements.reduce((tot, m) => {
            const amt = Number(m.amount);
            return m.type === 'ENTRADA' ? tot + amt : tot - amt;
        }, 0);
        
        /* ───── 4. Net for the day ───── */
        const totalEntradas = movements
        .filter((m) => m.type === 'ENTRADA')
        .reduce((s, m) => s + Number(m.amount), 0);
        
        const totalSalidas = movements
        .filter((m) => m.type === 'SALIDA')
        .reduce((s, m) => s + Number(m.amount), 0);
        
        const cajaReal = cajaAnterior + totalEntradas - totalSalidas;
        
        /* ───── 5. Category breakdown ───── */
        const byCategory = (cat: string) =>
            movements
        .filter((m) => m.category === cat)
        .reduce((s, m) => s + Number(m.amount), 0);
        
        const entraCaja        = byCategory('ENTRADA_GERENCIA');
        const totalCobros      = byCategory('COBRO_CLIENTE');
        const totalDesembolsos = byCategory('PRESTAMO');
        const totalGastos      = byCategory('GASTO_PROVEEDOR');
        
        /* ───── 6. KPIs “Renovados” & “Nuevos” from transactions ───── */
        // 6.1 Fetch all DISBURSEMENT transactions for the branch on that date
        const disbursements = await this.loanTransactionRepo.find({
            where: {
                Transactiontype: TransactionType.DISBURSEMENT,
                date: Between(start, end),
                loanRequest: { agent: { branch: { id: branchId } } },
            },
            relations: { loanRequest: { client: true, agent: { branch: true } } },
        });
        
        // 6.2 Gather unique client IDs
        const clientIds = disbursements.map((tx) => tx.loanRequest.client.id);
        
        // 6.3 Which of those clients already had a funded loan before today?
        const previousClientIds: number[] = [];
        if (clientIds.length) {
            const prev = await this.loanTransactionRepo
            .createQueryBuilder('tx')
            .select('loan.clientId', 'clientId')
            .innerJoin('tx.loanRequest', 'loan')
            .innerJoin('loan.agent', 'agent')
            .innerJoin('agent.branch', 'branch')
            .where('branch.id = :branchId', { branchId })
            .andWhere('tx.Transactiontype = :type', {
                type: TransactionType.DISBURSEMENT,
            })
            .andWhere('tx.createdAt < :start', { start })
            .andWhere('loan.clientId IN (:...ids)', { ids: clientIds })
            .distinct(true)
            .getRawMany();
            previousClientIds.push(...prev.map((r) => Number(r.clientId)));
        }
        const prevSet = new Set(previousClientIds);
        
        // 6.4 Sum requestedAmount for renewed vs new loans
        let totalRenovados = 0;
        let totalNuevos = 0;
        
        for (const tx of disbursements) {
            const req: LoanRequest = tx.loanRequest;
            const value = Number(req.requestedAmount ?? req.amount);
            if (prevSet.has(req.client.id)) {
                totalRenovados += value;
            } else {
                totalNuevos += value;
            }
        }
        
        /* ───── 7. Final dashboard ───── */
        return [
            { label: 'Caja anterior', value: cajaAnterior,   trend: '' },
            { label: 'Entra caja',    value: entraCaja,      trend: 'increase' },
            { label: 'Cobro',         value: totalCobros,    trend: 'increase' },
            { label: 'Préstamos',     value: totalDesembolsos, trend: 'decrease' },
            { label: 'Gastos',        value: totalGastos,    trend: 'decrease' },
            { label: 'Caja real',     value: cajaReal,       trend: '' },
            { label: 'Renovados',     value: totalRenovados, trend: 'increase' },
            { label: 'Nuevos',        value: totalNuevos,    trend: 'increase' },
        ];
    }
}
