import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CashMovement, CashMovementType } from 'src/entities/cash-movement.entity';
import { CashMovementCategory } from 'src/entities/cash-movement-category.enum';
import { Between, ILike, Repository } from 'typeorm';
import { LessThan } from 'typeorm';

@Injectable()
export class CashService {
    constructor(
        @InjectRepository(CashMovement)
        private readonly cashRepo: Repository<CashMovement>,
    ) {}
    
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
    ) {
        const query = this.cashRepo
        .createQueryBuilder('movement')
        .where('movement.branchId = :branchId', { branchId });
        
        if (search && typeof search === 'string') {
            query.andWhere('LOWER(movement.reference) LIKE :search', {
                search: `%${search.toLowerCase()}%`,
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
    
    
    /** Get totals for a specific day */

async getDailyTotals(branchId: number, date: Date) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);

    const end = new Date(date);
    end.setHours(23, 59, 59, 999);

    // Obtener todos los movimientos del día
    const movements = await this.cashRepo.find({
        where: {
            branch: { id: branchId },
            createdAt: Between(start, end),
        },
    });

    // Obtener movimientos anteriores para calcular cajaAnterior
    const previousMovements = await this.cashRepo.find({
        where: {
            branch: { id: branchId },
            createdAt: LessThan(start),
        },
    });

    const cajaAnterior = previousMovements.reduce((total, m) => {
        const amount = Number(m.amount);
        if (m.type === 'ENTRADA') return total + amount;
        if (m.type === 'SALIDA') return total - amount;
        return total;
    }, 0);

    const entradasCaja = movements
        .filter((m) => m.type === 'ENTRADA')
        .reduce((sum, m) => sum + Number(m.amount), 0);

    const salidasCaja = movements
        .filter((m) => m.type === 'SALIDA')
        .reduce((sum, m) => sum + Number(m.amount), 0);

    const totalCobros = movements
        .filter((m) => m.category === 'COBRO_CLIENTE')
        .reduce((sum, m) => sum + Number(m.amount), 0);

    const totalDesembolsos = movements
        .filter((m) => m.category === 'PRESTAMO')
        .reduce((sum, m) => sum + Number(m.amount), 0);

    return {
        cajaAnterior,
        entradasCaja,
        salidasCaja,
        totalCobros,
        totalDesembolsos,
    };
}

}
