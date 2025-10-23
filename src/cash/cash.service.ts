import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CashMovement, CashMovementType } from 'src/entities/cash-movement.entity';
import { CashMovementCategory } from 'src/entities/cash-movement-category.enum';
import { Between, ILike, LessThanOrEqual, Repository } from 'typeorm';
import { LessThan } from 'typeorm';
import { startOfDay, endOfDay, parseISO } from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { AgentClosing } from 'src/entities/agent-closing.entity';
import { LoanRequest, LoanRequestStatus } from 'src/entities/loan-request.entity';
import { LoanTransaction, TransactionType } from 'src/entities/transaction.entity';
import { format } from 'date-fns';
import { User } from 'src/entities/user.entity';
import { LoanRequestService } from 'src/loan-request/loan-request.service';
import { DataSource, Not } from 'typeorm';

/** Devuelve el rango [start, end] del día local Bogotá para 'YYYY-MM-DD' o Date */
function getBogotaDayRange(raw: string | Date) {
  let y: number, m: number, d: number;
  if (typeof raw === 'string') {
    const [yy, mm, dd] = raw.split('-').map(Number);
    y = yy; m = mm; d = dd;
  } else {
    const loc = new Date(raw);
    y = loc.getFullYear();
    m = loc.getMonth() + 1;
    d = loc.getDate();
  }
  const start = new Date(y, (m - 1), d, 0, 0, 0, 0);   // 00:00 hora local del servidor
  const end   = new Date(y, (m - 1), d, 23, 59, 59, 999);
  return { start, end };
}

/** YYYY-MM-DD en local (sin UTC) */
function formatYMDLocal(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** “YYYY-MM-DD HH:mm:ss” en local (útil para mostrar createdAt) */
function formatLocalDateTime(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}


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
    private readonly dataSource: DataSource, // 👈 inyecta DataSource

    
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
  * • ADMIN / MANAGER → full dashboard (same columns as antes).
  * • AGENT           → igual, excepto que oculta la tarjeta “Gastos”.
  *
  * Actualizado: KPIs “Renovados” y “Nuevos” se basan en transacciones de
  * DESEMBOLSO del día y en LoanRequest.status === 'RENEWED'.
  * Se mantiene el MISMO shape de respuesta.
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
    
    /* ─── 2 · Cash movements (igual que antes) ─── */
    const [today, history] = await Promise.all([
      this.cashRepo.find({
        where: { branch: { id: branchId }, createdAt: Between(start, end) },
      }),
      this.cashRepo.find({
        where: { branch: { id: branchId }, createdAt: LessThan(start) },
      }),
    ]);
    
    /* Opening cash (acumulado hasta antes de hoy) */
    const opening = history.reduce(
      (tot, m) => tot + (m.type === 'ENTRADA' ? +m.amount : -+m.amount),
      0,
    );
    
    /* Net para hoy (idéntico a tu lógica previa de caja) */
    const totalEntradas = today
    .filter((m) => m.type === 'ENTRADA')
    .reduce((s, m) => s + +m.amount, 0);
    
    const totalSalidas = today
    .filter((m) => m.type === 'SALIDA')
    .reduce((s, m) => s + +m.amount, 0);
    
    const realCash = opening + totalEntradas - totalSalidas;
    
    /* Helpers por categoría (igual que antes) */
    const byCategory = (cat: string) =>
      today
    .filter((m) => m.category === cat)
    .reduce((s, m) => s + +m.amount, 0);
    
    const entraCaja        = byCategory('ENTRADA_GERENCIA');
    const totalCobros      = byCategory('COBRO_CLIENTE');
    const totalDesembolsos = byCategory('PRESTAMO');
    const totalGastos      = byCategory('GASTO_PROVEEDOR');
    
    /* ──────────────────────────────────────────────
    * KPIs “Renovados” / “Nuevos” con la regla actual:
    *   - Renovado ⇢ loanRequest.status === 'RENEWED'
    *   - Día ⇢ fecha de la transacción de DESEMBOLSO (entre [start, end])
    *   - Nuevo ⇢ desembolso del día cuyo loanRequest.status !== 'RENEWED'
    * (sin usar PENALTY ni categorías de caja)
    * ────────────────────────────────────────────── */
    const disbursements = await this.loanTransactionRepo.find({
      where: {
        Transactiontype: TransactionType.DISBURSEMENT,
        date: Between(start, end),
        loanRequest: { agent: { branch: { id: branchId } } },
      },
      relations: { loanRequest: true },
    });
    
    const isRenewedStatus = (st: any) => {
      const s = String(st ?? '').toUpperCase();
      return s === 'RENEWED' || s === String(LoanRequestStatus.RENEWED);
    };
    
    let totalRenovados = 0;
    let countRenovados = 0;
    let totalNuevos    = 0;
    let countNuevos    = 0;
    
    // agrupamos por loanRequest para no duplicar si hay varias líneas del mismo desembolso
    const perLoanSum = new Map<number, number>();
    for (const tx of disbursements) {
      const lr = tx.loanRequest as LoanRequest | undefined;
      if (!lr) continue;
      const lrId = Number(lr.id);
      const amt  = Number((tx as any).amount ?? 0);
      perLoanSum.set(lrId, (perLoanSum.get(lrId) ?? 0) + amt);
    }
    
    for (const [lrId, amt] of perLoanSum.entries()) {
      // necesitamos el status del LR; ya viene en relations: { loanRequest: true }
      const tx = disbursements.find(t => Number((t.loanRequest as any)?.id) === lrId)!;
      const lr = tx.loanRequest as LoanRequest;
      
      if (isRenewedStatus(lr.status)) {
        totalRenovados += amt;
        countRenovados += 1;
      } else {
        totalNuevos += amt;
        countNuevos += 1;
      }
    }
    
    /* ─── 3 · Assemble tiles (MISMO SHAPE) ─── */
    const tiles = [
      { label: 'Caja anterior', value: opening },
      { label: 'Entra caja',    value: entraCaja,        trend: 'increase' },
      { label: 'Cobro',         value: totalCobros,      trend: 'increase' },
      { label: 'Préstamos',     value: totalDesembolsos, trend: 'decrease' },
      { label: 'Gastos',        value: totalGastos,      trend: 'decrease', hideForAgent: true },
      { label: 'Caja real',     value: realCash },
      { label: 'Renovados',     value: totalRenovados, trend: 'increase', amount: countRenovados },
      { label: 'Nuevos',        value: totalNuevos,    trend: 'increase', amount: countNuevos },
    ];
    
    /* Para AGENT, se ocultan tiles con hideForAgent */
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
    const { Raw } = require('typeorm'); // si ya tienes import de Raw arriba, quita esta línea
    
    // ───────── helpers internos ─────────
    const fmtYMDHMS = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      return `${y}-${m}-${dd} ${hh}:${mi}:${ss}`;
    };
    const fmtYMD = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${dd}`;
    };
    const localDayRange = (raw: string | Date) => {
      let y: number, m: number, d: number;
      if (typeof raw === 'string') {
        const [yy, mm, dd] = raw.split('-').map(Number);
        y = yy; m = mm; d = dd;
      } else {
        const loc = new Date(raw);
        y = loc.getFullYear(); m = loc.getMonth() + 1; d = loc.getDate();
      }
      const start = new Date(y, m - 1, d, 0, 0, 0, 0);         // 00:00:00 local
      const end   = new Date(y, m - 1, d, 23, 59, 59, 999);    // 23:59:59 local
      return { start, end, startStr: fmtYMDHMS(start), endStr: fmtYMDHMS(end) };
    };
    
    // (informativo) branch del usuario
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: { branch: true },
    });
    const branchId = user?.branch?.id ?? null;
    
    // 1) Ventana local del sistema (en strings para consultas)
    const { start, end, startStr, endStr } = localDayRange(rawDate);
    
    // 2) Dueño de NO-TRANSFER (por transaction→loanRequest→agent o adminId)
    const ownerIdForNonTransfer = (m: CashMovement): number | null =>
      (m as any)?.transaction?.loanRequest?.agent?.id ?? m.adminId ?? null;
    
    // 3) ¿Afecta saldo del agente?
    const affectsUserForBalance = (m: CashMovement): boolean => {
      if (m.category === C.TRANSFERENCIA) return m.origenId === userId; // SALIDA egresa; ENTRADA (invertida) ingresa
      return ownerIdForNonTransfer(m) === userId;
    };
    
    // 4) Movimientos (histórico y día) — usar Raw con strings locales para evitar desfases
    const [historyAll, todayAll] = await Promise.all([
      this.cashRepo.find({
        where: { createdAt: Raw((alias) => `${alias} < :start`, { start: startStr }) },
        relations: { transaction: { loanRequest: { agent: true } } },
      }),
      this.cashRepo.find({
        where: {
          createdAt: Raw((alias) => `${alias} BETWEEN :start AND :end`, {
            start: startStr,
            end: endStr,
          }),
        },
        relations: { transaction: { loanRequest: { agent: true } } },
      }),
    ]);
    
    const history = historyAll.filter(affectsUserForBalance);
    const today   = todayAll.filter(affectsUserForBalance);
    
    // 5) Base anterior (apertura)
    const baseAnterior = history.reduce(
      (tot, m) => (m.type === T.ENTRADA ? tot + +m.amount : tot - +m.amount),
      0
    );
    
    // 6) Sumas del día (solo con los que afectan saldo)
    const sumWhere = (pred: (m: CashMovement) => boolean) =>
      today.filter(pred).reduce((s, m) => s + +m.amount, 0);
    
    const transferIn  = sumWhere((m) => m.type === T.ENTRADA && m.category === C.TRANSFERENCIA && m.origenId === userId);
    const transferOut = sumWhere((m) => m.type === T.SALIDA  && m.category === C.TRANSFERENCIA && m.origenId === userId);
    
    const ingresosNoTransfer = sumWhere(
      (m) => m.type === T.ENTRADA && m.category !== C.TRANSFERENCIA && ownerIdForNonTransfer(m) === userId
    );
    const prestamosNuevos = sumWhere(
      (m) => m.type === T.SALIDA && m.category === C.PRESTAMO && ownerIdForNonTransfer(m) === userId
    );
    const gastos = sumWhere(
      (m) => m.type === T.SALIDA && m.category === C.GASTO_PROVEEDOR && ownerIdForNonTransfer(m) === userId
    );
    const cobros = sumWhere(
      (m) => m.type === T.ENTRADA && m.category === C.COBRO_CLIENTE && ownerIdForNonTransfer(m) === userId
    );
    
    // 7) Renovados del día (antes venía de penalties; ahora lo sobreescribimos con desembolsos del día)
    const penalties = await this.loanTransactionRepo.find({
      where: {
        Transactiontype: TransactionType.PENALTY,
        date: Raw((alias) => `${alias} BETWEEN :start AND :end`, {
          start: startStr,
          end: endStr,
        }),
        loanRequest: { agent: { id: userId } },
      },
      relations: { loanRequest: true },
    });
    // placeholder (no usamos requestedAmount):
    let totalRenovados = 0;
    
    // 8) Totales del día y saldo final (se recalculan al final cuando definamos totalRenovados real)
    const totalIngresosDia = ingresosNoTransfer + transferIn + cobros;
    let totalEgresosDia  = transferOut + prestamosNuevos + gastos + totalRenovados;
    let totalFinal       = baseAnterior + totalIngresosDia - totalEgresosDia;
    
    // 9) LISTA del día (unión: afectan saldo ∪ ligados al loanRequest del agente)
    const todayAgentTxAll = todayAll.filter(
      (m) => (m as any)?.transaction?.loanRequest?.agent?.id === userId
    );
    const byId = new Map<number, CashMovement>();
    for (const m of [...today, ...todayAgentTxAll]) byId.set(m.id, m);
    const todayForList = Array.from(byId.values());
    
    const movimientosDia = todayForList
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
      affectsBalance: affectsUserForBalance(m),
    }));
    
    // 10) Snapshot de cartera (a fin de día)
    const txs = await this.loanTransactionRepo.find({
      where: {
        date: Raw((alias) => `${alias} <= :end`, { end: endStr }),
        loanRequest: { agent: { id: userId } },
      },
      relations: { loanRequest: { client: true, agent: true } },
      order: { date: 'ASC', id: 'ASC' },
    });
    
    type LoanAgg = {
      loanRequestId: number;
      clientId?: number | null;
      clientName?: string | null;
      disbursed: number;   // base a pagar (LoanRequest.amount)
      repaid: number;
      penalties: number;
      fees: number;
      discounts: number;
      lastPaymentAt: Date | null;
      status?: string;     // estado en minúsculas
    };
    const perLoan = new Map<number, LoanAgg>();
    
    const isDisb        = (t: any) => String(t) === String(TransactionType.DISBURSEMENT);
    const isPenalty     = (t: any) => String(t) === String(TransactionType.PENALTY);
    const isPaymentLike = (t: any) => ['PAYMENT','REPAYMENT'].includes(String(t).toUpperCase());
    const isFee         = (t: any) => String(t).toUpperCase() === 'FEE';
    const isDiscount    = (t: any) => String(t).toUpperCase() === 'DISCOUNT';
    
    // Normalizador de estado (minúsculas)
    const toStatus = (lr?: LoanRequest) =>
      String((lr as any)?.status ?? '').trim().toLowerCase();
    
    for (const tx of txs) {
      const lr = tx.loanRequest as LoanRequest; if (!lr) continue;
      const id = lr.id;
      
      if (!perLoan.has(id)) {
        perLoan.set(id, {
          loanRequestId: id,
          clientId: (lr as any)?.client?.id ?? null,
          clientName: ((lr as any)?.client?.name ?? (lr as any)?.client?.fullName ?? null),
          disbursed: +((lr as any).amount ?? 0),  // base a pagar SOLO amount
          repaid: 0, penalties: 0, fees: 0, discounts: 0,
          lastPaymentAt: null,
          status: toStatus(lr),
        });
      }
      const agg = perLoan.get(id)!;
      const amt = +((tx as any).amount ?? 0);
      
      if (isDisb(tx.Transactiontype)) {
        // no-op: la base ya viene de lr.amount; NO sumar desembolsos aquí
      } else if (isPaymentLike(tx.Transactiontype)) {
        agg.repaid += amt;
        const d = (tx as any).date ? new Date((tx as any).date) : null;
        if (d && (!agg.lastPaymentAt || d > agg.lastPaymentAt)) agg.lastPaymentAt = d;
      } else if (isPenalty(tx.Transactiontype)) {
        // si las penalidades aumentan deuda y NO están incluidas en amount, descomenta:
        // agg.penalties += amt;
      } else if (isFee(tx.Transactiontype)) {
        // si los fees aumentan deuda y NO están incluidos en amount, descomenta:
        // agg.fees += amt;
      } else if (isDiscount(tx.Transactiontype)) {
        // si los descuentos reducen deuda y NO están ya aplicados, descomenta:
        // agg.discounts += amt;
      }
    }
    
    const loans = Array.from(perLoan.values()).map((l) => {
      // Si fees/penalties ya están incluidos en amount, deja solo (amount - pagos - descuentos).
      let outstanding = l.disbursed - l.repaid /* + l.penalties + l.fees */ - l.discounts;
      if (outstanding < 0) outstanding = 0;
      return { ...l, outstanding };
    });
    
    // Valor en cartera = SOLO 'funded' o 'renewed'
    const ACTIVE_FOR_PORTFOLIO = new Set(['funded','renewed']);
    const activeLoans = loans.filter(
      (l: any) => ACTIVE_FOR_PORTFOLIO.has(String(l.status)) && l.outstanding > 0.000001
    );
    
    // Clientes en deuda = todos los ≠ 'completed' y ≠ 'rejected'
    const EXCLUDE_FOR_DEBT = new Set(['completed','rejected']);
    const clientsInDebtSet = new Set<number>();
    for (const l of loans as any[]) {
      if (!EXCLUDE_FOR_DEBT.has(String(l.status))) {
        if (l.clientId) clientsInDebtSet.add(l.clientId as number);
      }
    }
    
    const portfolio = {
      asOf: end, // Date fin del día (local)
      agentId: userId,
      clientsCount: clientsInDebtSet.size, // 👈 clientes con estado distinto a completed/rejected
      loansCount: activeLoans.length,
      outstandingTotal: activeLoans.reduce((s: number, l: any) => s + l.outstanding, 0),
      loans: activeLoans
      .sort((a: any, b: any) => b.outstanding - a.outstanding)
      .map((l: any) => ({
        loanRequestId: l.loanRequestId,
        clientId: l.clientId,
        clientName: l.clientName,
        disbursed: l.disbursed,
        repaid: l.repaid,
        penalties: l.penalties,
        fees: l.fees,
        discounts: l.discounts,
        outstanding: l.outstanding,
        lastPaymentAt: l.lastPaymentAt,
        status: l.status,
      })),
    };
    
    // 11) KPI cobrado del día (pagos del día)
    const paymentsToday = await this.loanTransactionRepo.find({
      where: {
        date: Raw((alias) => `${alias} BETWEEN :start AND :end`, {
          start: startStr,
          end: endStr,
        }),
        loanRequest: { agent: { id: userId } },
      },
      relations: { loanRequest: true },
    });
    const valorCobradoDia = paymentsToday
    .filter((t) => isPaymentLike(t.Transactiontype))
    .reduce((s, t) => s + +((t as any).amount ?? 0), 0);
    
    // 12) KPI nuevos/renovados (desembolsos del día)
    const disbursalsToday = await this.loanTransactionRepo.find({
      where: {
        Transactiontype: TransactionType.DISBURSEMENT,
        date: Raw((alias) => `${alias} BETWEEN :start AND :end`, {
          start: startStr,
          end: endStr,
        }),
        loanRequest: { agent: { id: userId } },
      },
      relations: { loanRequest: { client: true } },
    });
    
    const NUEVO_CLIENTES = new Set<number>();
    const RENOV_CLIENTES = new Set<number>();
    let montoPrestadoNuevos = 0;
    let montoPrestadoRenovados = 0;
    
    for (const tx of disbursalsToday) {
      const lr = tx.loanRequest as LoanRequest;
      const clientId = (lr as any)?.client?.id;
      if (!clientId) continue;
      
      const desembolso = +((tx as any).amount ?? 0);
      const st = toStatus(lr); // 'funded' | 'renewed' | 'new' | ...
      
      if (st === 'renew' || st === 'renewed') {
        RENOV_CLIENTES.add(clientId);
        montoPrestadoRenovados += desembolso;
      } else if (st === 'funded') {
        NUEVO_CLIENTES.add(clientId);
        montoPrestadoNuevos += desembolso;
      }
    }
    
    // Fija el egreso de "renovados" a lo realmente desembolsado en renovaciones
    totalRenovados = montoPrestadoRenovados;
    // Recalcula egresos/total final con el valor definitivo de renovados
    totalEgresosDia  = transferOut + prestamosNuevos + gastos + totalRenovados;
    totalFinal       = baseAnterior + totalIngresosDia - totalEgresosDia;
    
    return {
      fecha: fmtYMD(start),  // solo referencia para UI
      usuario: userId,
      branchId,              // informativo
      baseAnterior,
      totalIngresosDia,
      totalEgresosDia,
      totalFinal,
      
      ingresos: { ingresosNoTransfer, transferIn, cobros },
      egresos:  { transferOut, prestamosNuevos, gastos, renovados: totalRenovados },
      
      movimientos: movimientosDia,
      
      kpis: {
        valorEnCartera: portfolio.outstandingTotal,       // suma de outstanding SOLO de funded/renewed
        clientesEnDeuda: portfolio.clientsCount,          // ≠ completed y ≠ rejected
        baseAnterior,
        valorCobradoDia,
        clientesNuevos:    { cantidad: NUEVO_CLIENTES.size,  montoPrestado: montoPrestadoNuevos },
        clientesRenovados: { cantidad: RENOV_CLIENTES.size,  montoPrestado: montoPrestadoRenovados },
      },
      
      portfolio,
    };
  }
  
  
  
  
  /**
  * Elimina un movimiento de caja y, si corresponde, su LoanTransaction.
  * Si deletePair=true y es TRANSFERENCIA, intenta eliminar también el "par".
  */
  async deleteMovement(
    id: number,
    opts: { deletePair?: boolean } = {},
  ): Promise<{
    deletedMovementId: number;
    deletedTransactionId?: number;
    deletedTransferPairId?: number;
  }> {
    const { deletePair = false } = opts;
    
    return this.dataSource.transaction(async (manager) => {
      const movementRepo = manager.getRepository(CashMovement);
      const txRepo = manager.getRepository(LoanTransaction);
      
      const mov = await movementRepo.findOne({
        where: { id },
        relations: { transaction: true },
      });
      if (!mov) throw new BadRequestException('Cash movement not found');
      
      // 1) Eliminar el movimiento principal
      let deletedTxId: number | undefined;
      
      if (mov.transaction?.id) {
        const txId = mov.transaction.id;
        
        // ¿Cuántos movements referencian esta transacción?
        const refs = await movementRepo.count({
          where: { transaction: { id: txId } },
        });
        
        // Eliminar el movement
        await movementRepo.delete(id);
        
        // Si nadie más la usa, elimina también la transacción
        if (refs <= 1) {
          await txRepo.delete(txId);
          deletedTxId = txId;
        }
      } else {
        await movementRepo.delete(id);
      }
      
      // 2) Si es transferencia y deletePair=true, intenta eliminar el par
      let deletedPairId: number | undefined;
      
      if (deletePair && mov.category === CashMovementCategory.TRANSFERENCIA) {
        const oppositeType: CashMovementType =
        mov.type === CashMovementType.ENTRADA  ? CashMovementType.SALIDA : CashMovementType.ENTRADA;
        
        const pair = await movementRepo.findOne({
          where: {
            id: Not(id),
            branchId: mov.branchId,
            category: CashMovementCategory.TRANSFERENCIA,
            amount: mov.amount,
            reference: mov.reference,
            origenId: mov.destinoId, // invertidos
            destinoId: mov.origenId, // invertidos
            type: oppositeType,
          },
          relations: { transaction: true },
        });
        
        if (pair) {
          if (pair.transaction?.id) {
            const refsPair = await movementRepo.count({
              where: { transaction: { id: pair.transaction.id } },
            });
            await movementRepo.delete(pair.id);
            if (refsPair <= 1) {
              await txRepo.delete(pair.transaction.id);
            }
          } else {
            await movementRepo.delete(pair.id);
          }
          deletedPairId = pair.id;
        }
      }
      
      return {
        deletedMovementId: id,
        deletedTransactionId: deletedTxId,
        deletedTransferPairId: deletedPairId,
      };
    });
  }
  
  
}
