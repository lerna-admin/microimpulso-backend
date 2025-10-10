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
import { User } from 'src/entities/user.entity';

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
        @InjectRepository(User)
        private readonly userRepository: Repository<User>,
        
        
    ) { }
    
    async registerMovement(data: any): Promise<CashMovement[]> {
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
        origenId,
        destinoId,
    } = data;

    // Validate typeMovement
    if (typeof typeMovement !== 'string') {
        throw new BadRequestException('typeMovement must be a string');
    }

    if (!['ENTRADA', 'SALIDA', 'TRANSFERENCIA'].includes(typeMovement)) {
        throw new BadRequestException('typeMovement must be "ENTRADA", "SALIDA" o "TRANSFERENCIA"');
    }

    // Validate amount
    if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) {
        throw new BadRequestException('amount must be a number greater than 0');
    }

    // Validate category
    if (typeof category !== 'string' || !category.trim()) {
        throw new BadRequestException('category must be a non-empty string');
    }

    // Transferencia: requiere origen y destino
    if (typeMovement === 'TRANSFERENCIA') {
        if (!origenId || !destinoId) {
            throw new BadRequestException('origenId y destinoId son requeridos para transferencias');
        }

        // Movimiento de salida (origen -> destino)
    const salida: Partial<CashMovement> = {
      type: 'SALIDA' as CashMovementType,
      amount,
      category: 'TRANSFERENCIA' as CashMovementCategory,
      reference,
      branchId,
      origenId,          // quien envía
      destinoId,         // quien recibe
      transaction: transactionId ? ({ id: transactionId } as any) : undefined,
    };

    // Movimiento de entrada (destino <- origen)
    const entrada: Partial<CashMovement> = {
      type: 'ENTRADA' as CashMovementType,
      amount,
      category: 'TRANSFERENCIA' as CashMovementCategory,
      reference,
      branchId,
      origenId: destinoId,  // 🔁 invertido correctamente
      destinoId: origenId,  // 🔁 invertido correctamente
      transaction: transactionId ? ({ id: transactionId } as any) : undefined,
    };
        const salidaMov = await this.cashRepo.save(this.cashRepo.create(salida));
        const entradaMov = await this.cashRepo.save(this.cashRepo.create(entrada));
        return [salidaMov, entradaMov];
    }

    // Movimiento normal
    const partialMovement: Partial<CashMovement> = {
        type: typeMovement as CashMovementType,
        amount,
        category: category as CashMovementCategory,
        reference,
        branchId,
        transaction: transactionId ? ({ id: transactionId } as any) : undefined,
    };

    const movement = this.cashRepo.create(partialMovement);
    return [await this.cashRepo.save(movement)];
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
                origen: m.origenId,
                destino : m.destinoId
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

    /**
   * Returns the branch-level dashboard for the day that belongs to `userId`.
   * • ADMIN / MANAGER → full dashboard (same columns as before).  
   * • AGENT           → identical, except the “Gastos” tile is omitted.
   */
  async getDailyTotalsByUser(userId: number, rawDate: Date | string) {
    /* ─── 0 · Resolve branch + role from the user ─── */
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: { branch: true },
    });
    if (!user?.branch?.id) throw new BadRequestException('User has no branch');
    const branchId = user.branch.id;
    const role     = user.role; // 'ADMIN' | 'AGENT' | 'MANAGER' …

    /* ─── 1 · [start, end] for local day ─── */
    const start =
    typeof rawDate === 'string'
    ? (() => {
        const [y, m, d] = rawDate.split('-').map(Number);
        return new Date(y, m - 1, d, 0, 0, 0, 0); // 00:00 local
    })()
    : new Date(rawDate.setHours(0, 0, 0, 0));
    
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);


    /* ─── 2 · Cash movements ─── */
    const [today, history] = await Promise.all([
      this.cashRepo.find({
        where: { branch: { id: branchId }, createdAt: Between(start, end) },
      }),
      this.cashRepo.find({
        where: { branch: { id: branchId }, createdAt: LessThan(start) },
      }),
    ]);

    /* Opening cash */
    const opening = history.reduce(
      (tot, m) => tot + (m.type === 'ENTRADA' ? +m.amount : -+m.amount),
      0,
    );

    /* Net for today */
    const totalEntradas = today
      .filter((m) => m.type === 'ENTRADA')
      .reduce((s, m) => s + +m.amount, 0);
    const totalSalidas = today
      .filter((m) => m.type === 'SALIDA')
      .reduce((s, m) => s + +m.amount, 0);
    const realCash = opening + totalEntradas - totalSalidas;

    /* Category helpers */
    const byCategory = (cat: string) =>
      today
        .filter((m) => m.category === cat)
        .reduce((s, m) => s + +m.amount, 0);

    const entraCaja        = byCategory('ENTRADA_GERENCIA');
    const totalCobros      = byCategory('COBRO_CLIENTE');
    const totalDesembolsos = byCategory('PRESTAMO');
    const totalGastos      = byCategory('GASTO_PROVEEDOR');

    /* KPIs: renovados / nuevos */
    const penalties = await this.loanTransactionRepo.find({
      where: {
        Transactiontype: TransactionType.PENALTY,
        date: Between(start, end),
        loanRequest: { agent: { branch: { id: branchId } } },
      },
      relations: { loanRequest: true },
    });
    const renewed = new Map<number, LoanRequest>();
    penalties.forEach((p) =>
      renewed.set(p.loanRequest.id, p.loanRequest as LoanRequest),
    );
    const totalRenovados = [...renewed.values()].reduce(
      (s, r) => s + +(r.requestedAmount ?? r.amount ?? 0),
      0,
    );

    const nuevosHoy = today.filter(
      (m) => m.type === 'SALIDA' && m.category === 'PRESTAMO',
    );
    const totalNuevos = nuevosHoy.reduce((s, m) => s + +m.amount, 0);

    /* ─── 3 · Assemble tiles ─── */
    const tiles = [
      { label: 'Caja anterior', value: opening },
      { label: 'Entra caja',    value: entraCaja,        trend: 'increase' },
      { label: 'Cobro',         value: totalCobros,      trend: 'increase' },
      { label: 'Préstamos',     value: totalDesembolsos, trend: 'decrease' },
      { label: 'Gastos',        value: totalGastos,      trend: 'decrease', hideForAgent: true },
      { label: 'Caja real',     value: realCash },
      { label: 'Renovados',     value: totalRenovados, amount: renewed.size },
      { label: 'Nuevos',        value: totalNuevos,  amount: nuevosHoy.length },
    ];

    /* For AGENT, remove any tile flagged hideForAgent */
    return role === 'AGENT' ? tiles.filter(t => !t.hideForAgent) : tiles;
  }

  /**
 * Traza diaria por USUARIO:
 * - baseAnterior (saldo de apertura del usuario)
 * - desglose de ingresos/egresos del día
 * - totalFinal
 * - lista de movimientos del día del usuario (para trazabilidad)
 */
async getDailyTraceByUser(userId: number, rawDate: Date | string) {
  const C = CashMovementCategory;
  const T = CashMovementType;

  // (Opcional) info del usuario/branch para la respuesta (no se usa para filtrar)
  const user = await this.userRepository.findOne({
    where: { id: userId },
    relations: { branch: true },
  });
  const branchId = user?.branch?.id ?? null;

  // 1) Ventana del día local [start, end]
  const start =
    typeof rawDate === 'string'
      ? (() => { const [y, m, d] = rawDate.split('-').map(Number); return new Date(y, m - 1, d, 0, 0, 0, 0); })()
      : new Date(new Date(rawDate).setHours(0, 0, 0, 0));
  const end = new Date(start); end.setHours(23, 59, 59, 999);

  // 2) Helper: dueño de un movimiento NO-TRANSFER (por transaction->loanRequest->agent o adminId)
  const ownerIdForNonTransfer = (m: CashMovement): number | null =>
    (m as any)?.transaction?.loanRequest?.agent?.id ?? m.adminId ?? null;

  // 3) Qué “afecta” el saldo del usuario:
  //    - TRANSFER: solo las filas donde el usuario es "origen" (coherente con tu inversión en ENTRADA)
  //    - NO-TRANSFER: si el "dueño" es el user (agent del request o adminId)
  const affectsUserForBalance = (m: CashMovement): boolean => {
    if (m.category === C.TRANSFERENCIA) {
      return m.origenId === userId; // tanto SALIDA (egreso) como ENTRADA invertida (ingreso)
    }
    return ownerIdForNonTransfer(m) === userId;
  };

  // 4) Cargar histórico y día (globales, sin filtrar por branch) con relaciones para poder resolver agent
  const [historyAll, todayAll] = await Promise.all([
    this.cashRepo.find({
      where: { createdAt: LessThan(start) },
      relations: { transaction: { loanRequest: { agent: true } } },
    }),
    this.cashRepo.find({
      where: { createdAt: Between(start, end) },
      relations: { transaction: { loanRequest: { agent: true } } },
    }),
  ]);

  const history = historyAll.filter(affectsUserForBalance);
  const today   = todayAll.filter(affectsUserForBalance);

  // 5) Base anterior (saldo apertura del usuario)
  const baseAnterior = history.reduce((tot, m) => (m.type === T.ENTRADA ? tot + +m.amount : tot - +m.amount), 0);

  // 6) Sumas del día (solo movimientos que afectan al usuario)
  const sumWhere = (pred: (m: CashMovement) => boolean) =>
    today.filter(pred).reduce((s, m) => s + +m.amount, 0);

  // Transferencias:
  const transferIn  = sumWhere((m) => m.type === T.ENTRADA && m.category === C.TRANSFERENCIA && m.origenId === userId);
  const transferOut = sumWhere((m) => m.type === T.SALIDA  && m.category === C.TRANSFERENCIA && m.origenId === userId);

  // No-transfer (propietario por transaction->agent o adminId):
  const ingresosNoTransfer = sumWhere(
    (m) => m.type === T.ENTRADA && m.category !== C.TRANSFERENCIA && ownerIdForNonTransfer(m) === userId,
  );
  const prestamosNuevos = sumWhere(
    (m) => m.type === T.SALIDA && m.category === C.PRESTAMO && ownerIdForNonTransfer(m) === userId,
  );
  const gastos = sumWhere(
    (m) => m.type === T.SALIDA && m.category === C.GASTO_PROVEEDOR && ownerIdForNonTransfer(m) === userId,
  );
  const cobros = sumWhere(
    (m) => m.type === T.ENTRADA && m.category === C.COBRO_CLIENTE && ownerIdForNonTransfer(m) === userId,
  );

  // 7) Renovados del día: por AGENTE (usuario), no por branch
  const penalties = await this.loanTransactionRepo.find({
    where: {
      Transactiontype: TransactionType.PENALTY,
      date: Between(start, end),
      loanRequest: { agent: { id: userId } },
    },
    relations: { loanRequest: true },
  });
  const renewed = new Map<number, LoanRequest>();
  penalties.forEach((p) => renewed.set(p.loanRequest.id, p.loanRequest as LoanRequest));
  const totalRenovados = [...renewed.values()].reduce(
    (s, req) => s + +(req.requestedAmount ?? req.amount ?? 0), 0,
  );

  // 8) Totales del día y saldo final
  const totalIngresosDia = ingresosNoTransfer + transferIn + cobros;
  const totalEgresosDia  = transferOut + prestamosNuevos + gastos + totalRenovados;
  const totalFinal       = baseAnterior + totalIngresosDia - totalEgresosDia;

  // 9) Trazabilidad del día (solo movimientos que afectan al usuario)
  const movimientosDia = today
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
    .map((m) => ({
      id: m.id,
      type: m.type,
      category: m.category,
      amount: +m.amount,
      createdAt: m.createdAt,
      description: m.reference,
      origen: m.origenId,
      destino: m.destinoId,
      agentId: (m as any)?.transaction?.loanRequest?.agent?.id ?? null,
      adminId: m.adminId ?? null,
    }));

  return {
    fecha: start.toISOString().slice(0, 10),
    usuario: userId,
    branchId, // informativo
    baseAnterior,
    totalIngresosDia,
    totalEgresosDia,
    totalFinal,
    ingresos: { ingresosNoTransfer, transferIn, cobros },
    egresos:  { transferOut, prestamosNuevos, gastos, renovados: totalRenovados },
    kpis: {
      renovados: { monto: totalRenovados, cantidad: renewed.size },
      nuevos:    {
        monto: prestamosNuevos,
        cantidad: today.filter(
          (m) => m.type === T.SALIDA && m.category === C.PRESTAMO && ownerIdForNonTransfer(m) === userId
        ).length,
      },
    },
    movimientos: movimientosDia,
  };
}



}
