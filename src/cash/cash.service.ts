import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CashMovement, CashMovementType } from 'src/entities/cash-movement.entity';
import { CashMovementCategory } from 'src/entities/cash-movement-category.enum';
import { CashFlow, CashFlowType } from 'src/entities/cash-flow.entity';
import {
  Between,
  In,
  Raw,
  Repository,
  LessThan,
  Not,
} from 'typeorm';
import { format } from 'date-fns';
import { AgentClosing } from 'src/entities/agent-closing.entity';
import { LoanRequest, LoanRequestStatus } from 'src/entities/loan-request.entity';
import { LoanTransaction, TransactionType } from 'src/entities/transaction.entity';
import { User } from 'src/entities/user.entity';
import { LoanRequestService } from 'src/loan-request/loan-request.service';
import { DataSource } from 'typeorm';
import * as ExcelJS from 'exceljs';
import PDFDocument = require('pdfkit');

/** Local helpers */
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
  const start = new Date(y, (m - 1), d, 0, 0, 0, 0);
  const end   = new Date(y, (m - 1), d, 23, 59, 59, 999);
  return { start, end };
}

function formatYMDLocal(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

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

function parseDateLike(value: Date | string): Date {
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return new Date(value);
  const normalized = value.trim().replace('T', ' ').replace('Z', '');
  const [datePart, timePart = '00:00:00'] = normalized.split(' ');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh = '0', mm = '0', rawSeconds = '0'] = timePart.split(':');
  const [ss = '0', frac = '0'] = rawSeconds.split('.');
  const ms = Number((frac + '000').slice(0, 3));
  return new Date(y, m - 1, d, Number(hh), Number(mm), Number(ss), ms);
}

@Injectable()
export class CashService {
  constructor(
    @InjectRepository(CashMovement)
    private readonly cashRepo: Repository<CashMovement>,
    @InjectRepository(CashFlow)
    private readonly cashFlowRepo: Repository<CashFlow>,
    @InjectRepository(AgentClosing)
    private readonly closingRepo: Repository<AgentClosing>,
    @InjectRepository(LoanTransaction)
    private readonly loanTransactionRepo: Repository<LoanTransaction>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    
    @InjectRepository(LoanRequest)
    private readonly loanRequestRepo: Repository<LoanRequest>,
    
    private readonly dataSource: DataSource,
  ) {}
  
  /**
  * Registers a manual cash movement.
  * If `userId` is provided by controller, we persist it into `adminId` for audit purposes.
  */
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
      adminId,     // legacy / optional
      branchId,
      transactionId,
      origenId,
      destinoId,
      userId,      // <-- performer user id sent by controller
    } = data;
    
    // Validate typeMovement
    if (typeof typeMovement !== 'string') {
      throw new BadRequestException('typeMovement must be a string');
    }
    
    if (!['ENTRADA', 'SALIDA', 'TRANSFERENCIA'].includes(typeMovement)) {
      throw new BadRequestException('typeMovement must be "ENTRADA", "SALIDA" or "TRANSFERENCIA"');
    }
    
    // Validate amount
    if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) {
      throw new BadRequestException('amount must be a number greater than 0');
    }
    
    // Validate category
    if (typeof category !== 'string' || !category.trim()) {
      throw new BadRequestException('category must be a non-empty string');
    }
    
    // Validate userId (optional but if present must be number)
    let performerId: number | undefined = undefined;
    if (userId !== undefined && userId !== null) {
      if (typeof userId !== 'number' || isNaN(userId) || userId <= 0) {
        throw new BadRequestException('userId must be a valid positive number if provided');
      }
      performerId = userId;
    } else if (adminId !== undefined && adminId !== null) {
      // keep backward compatibility
      if (typeof adminId === 'number' && !isNaN(adminId) && adminId > 0) {
        performerId = adminId;
      }
    }
    
    // TRANSFER: origin -> destination
    if (typeMovement === 'TRANSFERENCIA') {
      if (!origenId || !destinoId) {
        throw new BadRequestException('origenId and destinoId are required for TRANSFERENCIA');
      }
      
      const salida: Partial<CashMovement> = {
        type: 'SALIDA' as CashMovementType,
        amount,
        category: 'TRANSFERENCIA' as CashMovementCategory,
        reference,
        branchId,
        origenId,
        destinoId,
        adminId: performerId ?? undefined, // who executed this manual movement
        transaction: transactionId ? ({ id: transactionId } as any) : undefined,
      };
      
      const salidaMov = await this.cashRepo.save(this.cashRepo.create(salida));
      return [salidaMov];
    }
    
    // Regular movement (ENTRADA / SALIDA)
    const partialMovement: Partial<CashMovement> = {
      type: typeMovement as CashMovementType,
      amount,
      category: category as CashMovementCategory,
      reference,
      branchId,
      origenId,
      destinoId,
      adminId: performerId ?? undefined, // who executed this manual movement
      transaction: transactionId ? ({ id: transactionId } as any) : undefined,
    };
    
    const movement = this.cashRepo.create(partialMovement);
    return [await this.cashRepo.save(movement)];
  }
  
  /** Paginated movement list with optional search */
  // Reemplaza COMPLETO este método dentro de CashService
  async getMovements(
    branchId: number,
    limit = 10,
    page = 1,
    search?: string,
    date?: string,
    currentUser?: User, // ← opcional: si viene y es MANAGER, se filtra por país
  ) {
    const isManager = String(currentUser?.role ?? '').toUpperCase() === 'MANAGER';
    console.log('[CashService.getMovements] branchId=', branchId, 'isManager=', isManager, 'userId=', currentUser?.id);
    
    let managerCountryId: number | null = null;
    
    if (isManager) {
      const me = await this.userRepository.findOne({
        where: { id: currentUser!.id },
        relations: { branch: true },
      });
      managerCountryId = (me as any)?.branch?.countryId ?? null;
      if (!managerCountryId) {
        throw new BadRequestException('Manager sin país (branch.countryId) asignado');
      }
      console.log('[CashService.getMovements] managerCountryId=', managerCountryId);
    }
    
    // Usamos QB para soportar join con branch cuando sea por país
    const qb = this.cashRepo
    .createQueryBuilder('movement');
    
    if (isManager) {
      qb.leftJoin('movement.branch', 'branch')
      .where('branch.countryId = :cid', { cid: managerCountryId });
    } else {
      qb.where('movement.branchId = :branchId', { branchId });
    }
    
    if (search && typeof search === 'string' && search.trim()) {
      qb.andWhere('LOWER(movement.reference) LIKE :search', {
        search: `%${search.toLowerCase().trim()}%`,
      });
    }
    
    if (date) {
      // yyyy-MM-dd
      qb.andWhere('DATE(movement.createdAt) = :day', { day: date });
    }
    
    qb.orderBy('movement.createdAt', 'DESC')
    .skip((Math.max(1, page) - 1) * Math.max(1, limit))
    .take(Math.max(1, limit));
    
    const [rows, total] = await qb.getManyAndCount();
    console.log('[CashService.getMovements] rows=', rows.length, 'total=', total);
    
    // batch load users for origen/destino
    const ids = Array.from(
      new Set(
        rows
        .flatMap((m) => [m.origenId, m.destinoId])
        .filter((v): v is number => typeof v === 'number' && !isNaN(v)),
      ),
    );
    
    const usersById = new Map<number, { id: number; name: string; email?: string; role?: string }>();
    if (ids.length) {
      const users = await this.userRepository.find({
        where: { id: In(ids) },
        select: ['id', 'name', 'email', 'role'],
      });
      for (const u of users) usersById.set(u.id, u);
    }
    
    // --- Add-on: per-viewer transfer semantics (role-agnostic) ---
    const viewerId = currentUser?.id ?? null;
    
    const shaped = rows.map((m) => {
      const isTransfer = m.category === CashMovementCategory.TRANSFERENCIA;
      
      // Ignore DB `type` for transfers; derive direction by origen/destino only
      let affectsAs: 'ENTRADA' | 'SALIDA' | null = null;
      if (isTransfer && viewerId != null) {
        if (m.origenId === viewerId) {
          affectsAs = 'SALIDA';   // viewer sent the money
        } else if (m.destinoId === viewerId) {
          affectsAs = 'ENTRADA';  // viewer received the money
        }
      }
      
      // Mark as "expense for the viewer" iff viewer is the origin of a transfer
      const isExpenseForViewer = isTransfer && viewerId != null && m.origenId === viewerId;
      const expenseAmountForViewer = isExpenseForViewer ? Number(m.amount || 0) : 0;
      
      // Optional: user-facing category tag without touching enums/DB
      const categoryForUser = isExpenseForViewer ? 'GASTO_TRANSFERENCIA' : String(m.category);
      
      return {
        id: m.id,
        category: m.category,
        amount: m.amount,
        createdAt: m.createdAt,
        description: m.reference,
        origen: m.origenId ? usersById.get(m.origenId) ?? { id: m.origenId } : null,
        destino: m.destinoId ? usersById.get(m.destinoId) ?? { id: m.destinoId } : null,
        
        // Keep original DB type for compatibility
        type: m.type,
        
        // New derived fields (do not break existing consumers)
        isTransfer,
        affectsAs,                 // 'ENTRADA' | 'SALIDA' | null (per viewer)
        isExpenseForViewer,        // true if viewer is origenId of a transfer
        expenseAmountForViewer,    // amount to sum in "viewer expenses"
        categoryForUser,           // convenience flag for UI labeling
      };
    });
    
    // ⬇️ Use the shaped array in the response
    return {
      data: shaped,
      total,
      page: Math.max(1, page),
      limit: Math.max(1, limit),
    };
  }
  
  /**
  * Dashboard totals by branch and date.
  * (Optionally we can exclude admin-made disbursements from KPIs. Kept excluded for coherence.)
  */
  // Reemplaza COMPLETO este método dentro de CashService
  // Reemplaza COMPLETO este método dentro de CashService
  async getDailyTotals(
    branchId: number,
    rawDate: Date | string,
    currentUser?: User, // ← si viene y es MANAGER, se filtra por país
  ) {
    const isManager = String(currentUser?.role ?? '').toUpperCase() === 'MANAGER';
    console.log('[CashService.getDailyTotals] branchId=', branchId, 'isManager=', isManager, 'userId=', currentUser?.id);
    
    let start: Date;
    if (typeof rawDate === 'string') {
      const [y, m, d] = rawDate.split('-').map(Number);
      start = new Date(y, m - 1, d, 0, 0, 0, 0);
    } else {
      start = new Date(rawDate);
      start.setHours(0, 0, 0, 0);
    }
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    
    let managerCountryId: number | null = null;
    
    if (isManager) {
      const me = await this.userRepository.findOne({
        where: { id: currentUser!.id },
        relations: { branch: true },
      });
      managerCountryId = (me as any)?.branch?.countryId ?? null;
      if (!managerCountryId) {
        throw new BadRequestException('Manager sin país (branch.countryId) asignado');
      }
      console.log('[CashService.getDailyTotals] managerCountryId=', managerCountryId);
    }
    
    // -------- Movimientos (por branch o por país) --------
    let movements: CashMovement[] = [];
    let previousMovements: CashMovement[] = [];
    
    if (isManager) {
      movements = await this.cashRepo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.transaction', 'movementTransaction')
      .leftJoinAndSelect('movementTransaction.loanRequest', 'movementLoanRequest')
      .leftJoin('m.branch', 'b')
      .where('b.countryId = :cid', { cid: managerCountryId! })
      .andWhere('m.createdAt BETWEEN :start AND :end', { start, end })
      .getMany();
      
      previousMovements = await this.cashRepo
      .createQueryBuilder('m')
      .leftJoin('m.branch', 'b')
      .where('b.countryId = :cid', { cid: managerCountryId! })
      .andWhere('m.createdAt < :start', { start })
      .getMany();
    } else {
      [movements, previousMovements] = await Promise.all([
        this.cashRepo.find({
          where: {
            branch: { id: branchId },
            createdAt: Between(start, end),
          },
          relations: {
            transaction: { loanRequest: true },
          },
        }),
        this.cashRepo.find({
          where: {
            branch: { id: branchId },
            createdAt: LessThan(start),
          },
        }),
      ]);
    }
    
    const cajaAnterior = previousMovements.reduce((tot, m) => {
      const amt = +m.amount;
      return m.type === 'ENTRADA' ? tot + amt : tot - amt;
    }, 0);
    
    const totalEntradas = movements
    .filter((m) => m.type === 'ENTRADA')
    .reduce((s, m) => s + +m.amount, 0);
    
    const totalSalidas = movements
    .filter((m) => m.type === 'SALIDA')
    .reduce((s, m) => s + +m.amount, 0);
    
    const cajaReal = cajaAnterior + totalEntradas - totalSalidas;
    
    const byCategory = (cat: string) =>
      movements.filter((m) => m.category === cat).reduce((s, m) => s + +m.amount, 0);
    
    const entraCaja = byCategory('ENTRADA_GERENCIA');
    const totalCobros = byCategory('COBRO_CLIENTE');
    const totalDesembolsos = byCategory('PRESTAMO');
    const totalGastos = byCategory('GASTO_PROVEEDOR');
    
    const normalize = (value?: string | null) =>
      String(value ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    const statusLower = (value?: string | null) =>
      String(value ?? '').trim().toLowerCase();
    
    const loanMovements = movements
    .filter((m) => m.type === 'SALIDA' && m.category === 'PRESTAMO')
    .map((movement) => {
      const ref = normalize(movement.reference);
      const txStatus = statusLower(
        (movement.transaction as LoanTransaction | undefined)?.loanRequest?.status as any,
      );
      const isRenewal = ref.includes('renovacion') || txStatus === 'renewed';
      return { movement, isRenewal };
    });
    
    const renewalMovements = loanMovements.filter((entry) => entry.isRenewal);
    const newMovements = loanMovements.filter((entry) => !entry.isRenewal);
    
    const totalRenovados = renewalMovements.reduce(
      (sum, entry) => sum + +entry.movement.amount,
      0,
    );
    const countRenovados = renewalMovements.length;
    
    const totalNuevos = newMovements.reduce(
      (sum, entry) => sum + +entry.movement.amount,
      0,
    );
    const countNuevos = newMovements.length;
    
    console.log('[CashService.getDailyTotals] cajaAnterior=', cajaAnterior, 'cajaReal=', cajaReal);
    
    return [
      { label: 'Caja anterior', value: cajaAnterior, trend: '' },
      { label: 'Entra caja', value: entraCaja, trend: 'increase' },
      { label: 'Cobro', value: totalCobros, trend: 'increase' },
      { label: 'Préstamos', value: totalDesembolsos, trend: 'decrease' },
      { label: 'Gastos', value: totalGastos, trend: 'decrease' },
      { label: 'Caja real', value: cajaReal, trend: '' },
      { label: 'Renovados', value: totalRenovados, trend: 'decrease', amount: countRenovados },
      { label: 'Nuevos', value: totalNuevos, trend: 'decrease', amount: countNuevos },
    ];
  }
  
  
  
  /**
  * Dashboard tiles by user + date (agent view).
  * Excludes admin-made disbursements to avoid charging the agent for admin actions.
  */
  async getDailyTotalsByUser(userId: number, rawDate: Date | string) {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: { branch: true },
    });
    if (!user?.branch?.id) throw new BadRequestException('User has no branch');
    
    const branchId = user.branch.id;
    const role = (user.role ?? '').toUpperCase();
    const isAdminOrManager = role === 'ADMIN' || role === 'MANAGER';
    
    const start =
    typeof rawDate === 'string'
    ? (() => {
      const [y, m, d] = rawDate.split('-').map(Number);
      return new Date(y, m - 1, d, 0, 0, 0, 0);
    })()
    : new Date(rawDate.setHours(0, 0, 0, 0));
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    
    // ---------- Caja (branch) ----------
    const [today, history] = await Promise.all([
      this.cashRepo.find({
        where: { branch: { id: branchId }, createdAt: Between(start, end) },
      }),
      this.cashRepo.find({
        where: { branch: { id: branchId }, createdAt: LessThan(start) },
      }),
    ]);
    
    const opening = history.reduce(
      (tot, m) => tot + (m.type === 'ENTRADA' ? +m.amount : -+m.amount),
      0,
    );
    
    const totalEntradas = today
    .filter((m) => m.type === 'ENTRADA')
    .reduce((s, m) => s + +m.amount, 0);
    
    const totalSalidas = today
    .filter((m) => m.type === 'SALIDA')
    .reduce((s, m) => s + +m.amount, 0);
    
    const realCash = opening + totalEntradas - totalSalidas;
    
    const byCategory = (cat: string) =>
      today
    .filter((m) => m.category === cat)
    .reduce((s, m) => s + +m.amount, 0);
    
    const entraCaja = byCategory('ENTRADA_GERENCIA');
    const totalCobros = byCategory('COBRO_CLIENTE');
    const totalDesembolsos = byCategory('PRESTAMO');
    const totalGastos = byCategory('GASTO_PROVEEDOR');
    
    // ---------- KPIs (regla nueva) ----------
    const statusLower = (v: any) => String(v ?? '').trim().toLowerCase();
    
    let totalRenovados = 0;
    let countRenovados = 0;
    let totalNuevos = 0;
    let countNuevos = 0;
    
    if (isAdminOrManager) {
      // ADMIN/MANAGER: incluir TODOS los desembolsos del día en la sede
      const disbursementsAll = await this.loanTransactionRepo.find({
        where: {
          Transactiontype: TransactionType.DISBURSEMENT,
          date: Between(start, end),
          loanRequest: { agent: { branch: { id: branchId } } },
        },
        relations: { loanRequest: true },
      });
      
      // Agrupar monto de transacciones por loan para el día
      const perLoanSum = new Map<number, number>();
      const perLoanStatus = new Map<number, string>();
      
      for (const tx of disbursementsAll) {
        const lr = tx.loanRequest as LoanRequest | undefined;
        if (!lr) continue;
        const lrId = Number(lr.id);
        const amt = Number((tx as any).amount ?? 0);
        perLoanSum.set(lrId, (perLoanSum.get(lrId) ?? 0) + (isFinite(amt) ? amt : 0));
        perLoanStatus.set(lrId, statusLower((lr as any).status));
      }
      
      const seenRenew = new Set<number>();
      const seenNew = new Set<number>();
      
      for (const [lrId, sumAmt] of perLoanSum.entries()) {
        const st = perLoanStatus.get(lrId) || '';
        if (st === 'renewed') {
          if (!seenRenew.has(lrId)) {
            seenRenew.add(lrId);
            countRenovados += 1;
          }
          totalRenovados += sumAmt; // suma de montos de transacciones
        } else {
          if (!seenNew.has(lrId)) {
            seenNew.add(lrId);
            countNuevos += 1;
          }
          totalNuevos += sumAmt; // suma de montos de transacciones
        }
      }
    } else {
      // AGENT: excluir transacciones realizadas por admin
      const disbursements = await this.loanTransactionRepo.find({
        where: {
          Transactiontype: TransactionType.DISBURSEMENT,
          date: Between(start, end),
          loanRequest: { agent: { id: userId } },
          isAdminTransaction: false as any,
        },
        relations: { loanRequest: true },
      });
      
      const perLoanSum = new Map<number, number>();
      const perLoanStatus = new Map<number, string>();
      
      for (const tx of disbursements) {
        const lr = tx.loanRequest as LoanRequest | undefined;
        if (!lr) continue;
        const lrId = Number(lr.id);
        const amt = Number((tx as any).amount ?? 0);
        perLoanSum.set(lrId, (perLoanSum.get(lrId) ?? 0) + (isFinite(amt) ? amt : 0));
        perLoanStatus.set(lrId, statusLower((lr as any).status));
      }
      
      const seenRenew = new Set<number>();
      const seenNew = new Set<number>();
      
      for (const [lrId, sumAmt] of perLoanSum.entries()) {
        const st = perLoanStatus.get(lrId) || '';
        if (st === 'renewed') {
          if (!seenRenew.has(lrId)) {
            seenRenew.add(lrId);
            countRenovados += 1;
          }
          totalRenovados += sumAmt;
        } else {
          if (!seenNew.has(lrId)) {
            seenNew.add(lrId);
            countNuevos += 1;
          }
          totalNuevos += sumAmt;
        }
      }
    }
    
    const tiles = [
      { label: 'Caja anterior', value: opening },
      { label: 'Entra caja', value: entraCaja, trend: 'increase' },
      { label: 'Nuevos', value: totalNuevos, trend: 'decrease', amount: countNuevos },
      
      
      { label: 'Préstamos', value: totalDesembolsos, trend: 'decrease', amount : countNuevos + countRenovados },
      { label: 'Caja real', value: realCash },
      { label: 'Cobro', value: totalCobros, trend: 'increase' },
      
      { label: 'Renovados', value: totalRenovados, trend: 'decrease', amount: countRenovados },
      { label: 'Gastos', value: totalGastos, trend: 'decrease', hideForAgent: true },
      
    ];
    
    return role === 'AGENT' ? tiles.filter((t) => !t.hideForAgent) : tiles;
  }
  
  
  /**
  * Daily trace by USER (agent cash closing).
  * - Excludes admin-made loan disbursements from agent balance and KPIs.
  * - Uses `adminId` in manual movements to attribute performer when there is no loan/agent.
  */
  async getDailyTraceByUser(userId: number, rawDate: Date | string) {
    const C = CashMovementCategory;
    const T = CashMovementType;
    
    console.log('[CashService.getDailyTraceByUser] start', { userId, rawDate });
    
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
      const start = new Date(y, m - 1, d, 0, 0, 0, 0);
      const end = new Date(y, m - 1, d, 23, 59, 59, 999);
      return { start, end, startStr: fmtYMDHMS(start), endStr: fmtYMDHMS(end) };
    };
    
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: { branch: true },
    });
    const branchId = user?.branch?.id ?? null;
    
    const { start, end, startStr, endStr } = localDayRange(rawDate);
    const bufferStart = new Date(start);
    bufferStart.setHours(bufferStart.getHours() - 6);
    const bufferEnd = new Date(end);
    bufferEnd.setHours(bufferEnd.getHours() + 6);
    const bufferStartStr = fmtYMDHMS(bufferStart);
    const bufferEndStr = fmtYMDHMS(bufferEnd);
    const targetDayStr = fmtYMD(start);
    const isTargetDay = (date: Date | string) => fmtYMD(parseDateLike(date)) === targetDayStr;
    
    // Attribution helpers
    const ownerIdForNonTransfer = (m: CashMovement): number | null => {
      const tx = (m as any)?.transaction as (LoanTransaction | undefined);
      // If the linked loan transaction was performed by admin, do not attribute to agent
      if (tx && (tx as any).isAdminTransaction === true) return null;
      
      // Otherwise attribute to the loan's agent; fallback to performer adminId for manual movements
      return tx?.loanRequest?.agent?.id ?? (m as any)?.adminId ?? null;
    };
    
    const affectsUserForBalance = (m: CashMovement): boolean => {
      // Transfers: belongs to 'origenId'
      if (m.category === C.TRANSFERENCIA) return m.origenId === userId;
      // Non-transfers: attribute only if the "owner" matches the agent
      return ownerIdForNonTransfer(m) === userId;
    };
    
    const todayAll = await this.cashRepo.find({
      where: {
        createdAt: Raw((alias) => `${alias} BETWEEN :start AND :end`, {
          start: startStr,
          end: endStr,
        }),
      },
      relations: { transaction: { loanRequest: { agent: true, client: true } } },
    });
    
    const today = todayAll.filter(affectsUserForBalance);
  
    const rawBase = await this.cashFlowRepo
      .createQueryBuilder('cf')
      .select(
        `COALESCE(SUM(CASE WHEN cf.type = :income THEN cf.amount ELSE -cf.amount END), 0)`,
        'saldo',
      )
      .where('cf.userId = :userId', { userId })
      .andWhere('cf.createdAt < :start', { start })
      .setParameters({ income: CashFlowType.INCOME })
      .getRawOne<{ saldo?: string }>();
    const baseAnterior = Number(rawBase?.saldo ?? 0);
    
    const sumWhere = (pred: (m: CashMovement) => boolean) =>
      today.filter(pred).reduce((s, m) => s + +m.amount, 0);
    
    const transferIn = sumWhere(
      (m) => m.type === T.ENTRADA && m.category === C.TRANSFERENCIA && m.origenId === userId,
    );
    const transferOut = sumWhere(
      (m) => m.type === T.SALIDA && m.category === C.TRANSFERENCIA && m.origenId === userId,
    );
    
    const ingresosNoTransfer = sumWhere(
      (m) =>
        m.type === T.ENTRADA &&
      m.category !== C.TRANSFERENCIA &&
      m.category !== C.COBRO_CLIENTE &&
      ownerIdForNonTransfer(m) === userId,
    );
    const gastos = sumWhere(
      (m) =>
        m.type === T.SALIDA &&
      m.category === C.GASTO_PROVEEDOR &&
      ownerIdForNonTransfer(m) === userId,
    );
    let cobros = sumWhere(
      (m) =>
        m.type === T.ENTRADA &&
      m.category === C.COBRO_CLIENTE &&
      ownerIdForNonTransfer(m) === userId,
    );
    
    const toStatus = (lr?: LoanRequest) => String(lr?.status ?? '').trim().toLowerCase();
    
    // Key: only count agent-made disbursements (exclude admin-made).
    const disbursalCandidates = await this.cashRepo.find({
      where: {
        type: T.SALIDA,
        category: C.PRESTAMO,
        ...(branchId ? { branchId } : {}),
        createdAt: Raw((alias) => `${alias} BETWEEN :start AND :end`, {
          start: startStr,
          end: endStr,
        }),
      },
      relations: { transaction: { loanRequest: { agent: true, client: true } } },
    });
    const disbursalsToday = disbursalCandidates.filter(
      (m) => ownerIdForNonTransfer(m) === userId && m.transaction?.loanRequest,
    );
  
    let totalNuevos = 0;
    let totalRenovados = 0;
    const NUEVO_CLIENTES = new Set<number>();
    const RENOV_CLIENTES = new Set<number>();
    
    for (const mov of disbursalsToday) {
      const lr = (mov as any)?.transaction?.loanRequest as LoanRequest | undefined;
      if (!lr) continue;
      const amt = Number(mov.amount ?? 0);
      const st = toStatus(lr);
      const clientId = (lr as any)?.client?.id;
      const isRenewal = st === 'renewed' || Boolean((lr as any)?.isRenewed);
      
      if (isRenewal) {
        totalRenovados += amt;
        if (clientId) RENOV_CLIENTES.add(clientId);
      } else {
        totalNuevos += amt;
        if (clientId) NUEVO_CLIENTES.add(clientId);
      }
    }
    
    if (totalRenovados === 0) {
      console.log('[CashService.getDailyTraceByUser] renewals fallback triggered', { userId, rawDate });
      const renewedFallback = await this.cashRepo.find({
        where: {
          type: T.SALIDA,
          category: C.PRESTAMO,
          createdAt: Raw((alias) => `${alias} BETWEEN :start AND :end`, {
            start: startStr,
            end: endStr,
          }),
        },
        relations: { transaction: { loanRequest: { agent: true, client: true } } },
      });
      for (const mov of renewedFallback) {
        const lr = (mov as any)?.transaction?.loanRequest as LoanRequest | undefined;
        if (!lr) continue;
        if (toStatus(lr) !== 'renewed') continue;
        if (ownerIdForNonTransfer(mov) !== userId) continue;
        totalRenovados += Number(mov.amount ?? 0);
        const cid = (lr as any)?.client?.id;
        if (cid) RENOV_CLIENTES.add(cid);
      }
    }
    
    const totalIngresosDia = ingresosNoTransfer + transferIn + cobros;
    const totalEgresosDia = transferOut + gastos + totalNuevos + totalRenovados;
    const totalFinal = baseAnterior + totalIngresosDia - totalEgresosDia;
    
    console.log('[CashService.getDailyTraceByUser] totals', {
      userId,
      rawDate,
      baseAnterior,
      totalIngresosDia,
      totalEgresosDia,
      totalFinal,
      nuevos: { cantidad: NUEVO_CLIENTES.size, monto: totalNuevos },
      renovados: { cantidad: RENOV_CLIENTES.size, monto: totalRenovados },
      cobros,
    });
    
    const todayAgentTxAll = todayAll.filter(
      (m) => (m as any)?.transaction?.loanRequest?.agent?.id === userId,
    );
    const byId = new Map<number, CashMovement>();
    for (const m of [...today, ...todayAgentTxAll]) byId.set(m.id, m);
    const todayForList = Array.from(byId.values());
    
    const movimientosDia = todayForList
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
    .map((m) => {
      const lr = (m as any)?.transaction?.loanRequest;
      const client = lr?.client;
      return {
        id: m.id,
        type: m.type,
        category: m.category,
        amount: +m.amount,
        createdAt: m.createdAt,
        description: m.reference,
        origen: m.origenId,
        destino: m.destinoId,
        agentId: lr?.agent?.id ?? (m as any)?.transaction?.loanRequest?.agent?.id ?? null,
        adminId: m.adminId ?? null,
        affectsBalance: affectsUserForBalance(m),
        
        // excel helpers
        loanRequestId: lr?.id ?? null,
        clientName: client?.name ?? client?.fullName ?? null,
        clientDocument:
        client?.document ??
        (client as any)?.dni ??
        (client as any)?.cedula ??
        (client as any)?.identification ??
        null,
      };
    });
    
    // Portfolio snapshot up to end of day
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
      disbursed: number;
      requestedAmount: number;
      repaid: number;
      penalties: number;
      fees: number;
      discounts: number;
      lastPaymentAt: Date | null;
      status?: string;
    };
    const perLoan = new Map<number, LoanAgg>();
    
    const isDisb = (t: any) => String(t).toLowerCase() === 'disbursement';
    const isPenalty = (t: any) => String(t).toLowerCase() === 'penalty';
    const isPaymentLike = (t: any) => {
      const s = String(t).toLowerCase();
      return s === 'repayment' || s === 'payment';
    };
    const isFee = (t: any) => String(t).toLowerCase() === 'fee';
    const isDiscount = (t: any) => String(t).toLowerCase() === 'discount';
    
    const statusLower = (lr?: LoanRequest) => String((lr as any)?.status ?? '').trim().toLowerCase();
    
    for (const tx of txs) {
      const lr = tx.loanRequest as LoanRequest;
      if (!lr) continue;
      const id = lr.id;
      
      if (!perLoan.has(id)) {
        perLoan.set(id, {
          loanRequestId: id,
          clientId: (lr as any)?.client?.id ?? null,
          clientName:
          ((lr as any)?.client?.name ?? (lr as any)?.client?.fullName ?? null),
          disbursed: +((lr as any).amount ?? 0),
          requestedAmount: +((lr as any).requestedAmount ?? (lr as any).amount ?? 0),
          repaid: 0,
          penalties: 0,
          fees: 0,
          discounts: 0,
          lastPaymentAt: null,
          status: statusLower(lr),
        });
      }
      const agg = perLoan.get(id)!;
      const amt = +((tx as any).amount ?? 0);
      
      if (isDisb(tx.Transactiontype)) {
        // base disbursed comes from the loan itself
      } else if (isPaymentLike(tx.Transactiontype)) {
        agg.repaid += amt;
        const d = (tx as any).date ? new Date((tx as any).date) : null;
        if (d && (!agg.lastPaymentAt || d > agg.lastPaymentAt)) agg.lastPaymentAt = d;
      } else if (isPenalty(tx.Transactiontype)) {
        // penalties aggregation (optional)
      } else if (isFee(tx.Transactiontype)) {
        // fees aggregation (optional)
      } else if (isDiscount(tx.Transactiontype)) {
        // discounts aggregation (optional)
      }
    }
    
    const loans = Array.from(perLoan.values()).map((l) => {
      let outstanding = l.disbursed - l.repaid - l.discounts;
      if (outstanding < 0) outstanding = 0;
      return { ...l, outstanding };
    });
    
    const ACTIVE_FOR_PORTFOLIO = new Set(['funded', 'renewed']);
    const activeLoans = loans.filter(
      (l: any) => ACTIVE_FOR_PORTFOLIO.has(String(l.status)) && l.outstanding > 0.000001,
    );
    
    const EXCLUDE_FOR_DEBT = new Set(['completed', 'rejected']);
    const clientsInDebtSet = new Set<number>();
    for (const l of loans as any[]) {
      if (!EXCLUDE_FOR_DEBT.has(String(l.status))) {
        if (l.clientId) clientsInDebtSet.add(l.clientId as number);
      }
    }
    
    const portfolio = {
      asOf: end,
      agentId: userId,
      clientsCount: clientsInDebtSet.size,
      loansCount: activeLoans.length,
      outstandingTotal: activeLoans.reduce((s: number, l: any) => s + l.outstanding, 0),
      loans: activeLoans
      .sort((a: any, b: any) => b.outstanding - a.outstanding)
      .map((l: any) => ({
        loanRequestId: l.loanRequestId,
        clientId: l.clientId,
        clientName: l.clientName,
        disbursed: l.disbursed,
        requestedAmount: l.requestedAmount,
        repaid: l.repaid,
        penalties: l.penalties,
        fees: l.fees,
        discounts: l.discounts,
        outstanding: l.outstanding,
        lastPaymentAt: l.lastPaymentAt,
        status: l.status,
      })),
    };
    
    // If you also want to exclude admin-made payments from "valorCobradoDia", keep filter below.
    const paymentsCandidates = await this.loanTransactionRepo.find({
      where: {
        date: Raw((alias) => `${alias} BETWEEN :start AND :end`, {
          start: bufferStartStr,
          end: bufferEndStr,
        }),
        loanRequest: { agent: { id: userId } },
        isAdminTransaction: false as any, // exclude admin-made payments from agent KPI
      },
      relations: { loanRequest: true },
    });
    const paymentsToday = paymentsCandidates.filter((tx) => isTargetDay(tx.date as any));
    const valorCobradoDia = paymentsToday
    .filter((t) => {
      const s = String(t.Transactiontype).toLowerCase();
      return s === 'repayment' || s === 'payment';
    })
    .reduce((s, t) => s + +((t as any).amount ?? 0), 0);
    if (valorCobradoDia > 0) cobros = valorCobradoDia;
    
    // --- ADD-ON CORREGIDO (sin 'data?.kpis') ---
    // --- CORRECCIÓN TRANSFERENCIAS (ignorar 'type') ---
    // Calc sobre todayAll (sin filtros) para ver ambas direcciones
    const transferEntrante = todayAll
    .filter((m) => m.category === C.TRANSFERENCIA && m.destinoId == userId)
    .reduce((s, m) => s + Number(m.amount || 0), 0);
    
    const transferSaliente = todayAll
    .filter((m) => m.category === C.TRANSFERENCIA && m.origenId == userId)
    .reduce((s, m) => s + Number(m.amount || 0), 0);
    
    // Totales corregidos que SÍ afectan resultados finales
    const totalIngresosDia_corr = ingresosNoTransfer + cobros + transferEntrante;
    const totalEgresosDia_corr  = gastos + totalNuevos + totalRenovados + transferSaliente;
    const totalFinal_corr       = baseAnterior + totalIngresosDia_corr - totalEgresosDia_corr;
    
    // KPIs nuevos informativos
    const kpisExtendidos = {
      entradaDeDinero: totalIngresosDia_corr,
      salidaDeDinero : totalEgresosDia_corr,
      transferEntrante,
      transferSaliente,
      transferNeta: transferEntrante - transferSaliente,
    };
    
    // --- RETURN usando los CORREGIDOS ---
    return {
      fecha: fmtYMD(start),
      usuario: userId,
      branchId,
      baseAnterior,
      
      // Usar los corregidos:
      totalIngresosDia: totalIngresosDia_corr,
      totalEgresosDia : totalEgresosDia_corr,
      totalFinal      : totalFinal_corr,
      
      // Conserva tus desgloses previos; si quieres, refleja también los corregidos:
      ingresos: { ingresosNoTransfer, transferIn: transferEntrante, cobros },
      egresos : { transferOut: transferSaliente, prestamosNuevos: totalNuevos, gastos, renovados: totalRenovados },
      
      movimientos: movimientosDia,
      
      kpis: {
        valorEnCartera: portfolio.outstandingTotal,
        clientesEnDeuda: portfolio.clientsCount,
        baseAnterior,
        valorCobradoDia,
        clientesNuevos: { cantidad: NUEVO_CLIENTES.size, montoPrestado: totalNuevos },
        clientesRenovados: { cantidad: RENOV_CLIENTES.size, montoPrestado: totalRenovados },
        ...kpisExtendidos, // nuevos KPIs de transferencias y entradas/salidas
      },
      
      portfolio,
    };
    
  }
  
  /**
  * Delete a cash movement (and cleanup related tx if orphan).
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
      
      let deletedTxId: number | undefined;
      
      if (mov.transaction?.id) {
        const txId = mov.transaction.id;
        
        const refs = await movementRepo.count({
          where: { transaction: { id: txId } },
        });
        
        await movementRepo.delete(id);
        
        if (refs <= 1) {
          await txRepo.delete(txId);
          deletedTxId = txId;
        }
      } else {
        await movementRepo.delete(id);
      }
      
      let deletedPairId: number | undefined;
      
      if (deletePair && mov.category === CashMovementCategory.TRANSFERENCIA) {
        const oppositeType: CashMovementType =
        mov.type === CashMovementType.ENTRADA ? CashMovementType.SALIDA : CashMovementType.ENTRADA;
        
        const pair = await movementRepo.findOne({
          where: {
            id: Not(id),
            branchId: mov.branchId,
            category: CashMovementCategory.TRANSFERENCIA,
            amount: mov.amount,
            reference: mov.reference,
            origenId: mov.destinoId,
            destinoId: mov.origenId,
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
  
  // ----------------- EXPORTS -----------------
  
  async exportDailyTraceToExcel(userId: number, date: string): Promise<Buffer> {
    const data = await this.getDailyTraceByUser(userId, date);
    
    const ExcelMod = await import('exceljs');
    const ExcelJS: any = (ExcelMod as any).default ?? ExcelMod;
    
    const wb = new ExcelJS.Workbook();
    wb.creator = 'CashService';
    wb.created = new Date();
    
    // --- Summary ---
    const wsResumen = wb.addWorksheet('Resumen');
    wsResumen.columns = [
      { header: 'Campo', key: 'k', width: 32 },
      { header: 'Valor', key: 'v', width: 32 },
    ];
    wsResumen.addRows([
      { k: 'Fecha', v: data.fecha },
      { k: 'Usuario', v: data.usuario },
      { k: 'Sucursal (branchId)', v: data.branchId ?? '—' },
      { k: 'Base anterior', v: data.baseAnterior },
      { k: 'Ingresos del día', v: data.totalIngresosDia },
      { k: 'Egresos del día', v: data.totalEgresosDia },
      { k: 'Total final', v: data.totalFinal },
      { k: 'Cobrado hoy (kpi)', v: data.kpis?.valorCobradoDia ?? 0 },
      { k: 'Clientes en deuda (kpi)', v: data.kpis?.clientesEnDeuda ?? 0 },
      { k: 'Valor en cartera (kpi)', v: data.kpis?.valorEnCartera ?? 0 },
      { k: 'Nuevos (cant)', v: data.kpis?.clientesNuevos?.cantidad ?? 0 },
      { k: 'Nuevos (monto)', v: data.kpis?.clientesNuevos?.montoPrestado ?? 0 },
      { k: 'Renovados (cant)', v: data.kpis?.clientesRenovados?.cantidad ?? 0 },
      { k: 'Renovados (monto)', v: data.kpis?.clientesRenovados?.montoPrestado ?? 0 },
    ]);
    
    // --- Ingresos / Egresos ---
    const wsIE = wb.addWorksheet('Ingresos_Egresos');
    wsIE.columns = [
      { header: 'Grupo', key: 'g', width: 22 },
      { header: 'Concepto', key: 'c', width: 28 },
      { header: 'Monto', key: 'm', width: 18 },
    ];
    wsIE.addRows([
      { g: 'Ingresos', c: 'Ingresos No Transfer', m: data.ingresos?.ingresosNoTransfer ?? 0 },
      { g: 'Ingresos', c: 'Transferencias Entrantes', m: data.ingresos?.transferIn ?? 0 },
      { g: 'Ingresos', c: 'Cobros', m: data.ingresos?.cobros ?? 0 },
      { g: 'Egresos', c: 'Transferencias Salientes', m: data.egresos?.transferOut ?? 0 },
      { g: 'Egresos', c: 'Gastos', m: data.egresos?.gastos ?? 0 },
      { g: 'Egresos', c: 'Préstamos Nuevos', m: data.egresos?.prestamosNuevos ?? 0 },
      { g: 'Egresos', c: 'Renovados', m: data.egresos?.renovados ?? 0 },
    ]);
    
    // --- Movimientos ---
    const wsMov = wb.addWorksheet('Movimientos');
    wsMov.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Tipo', key: 'type', width: 12 },
      { header: 'Categoría', key: 'category', width: 22 },
      { header: 'Monto', key: 'amount', width: 14 },
      { header: 'Fecha', key: 'createdAt', width: 22 },
      { header: 'Descripción', key: 'description', width: 30 },
      { header: 'Origen', key: 'origen', width: 12 },
      { header: 'Destino', key: 'destino', width: 12 },
      { header: 'Cliente', key: 'clientName', width: 25 },
      { header: 'Doc. cliente', key: 'clientDocument', width: 20 },
      { header: 'Solicitud', key: 'loanRequestId', width: 14 },
      { header: 'Afecta saldo', key: 'affectsBalance', width: 14 },
    ];
    wsMov.addRows(
      (data.movimientos || []).map((m: any) => ({
        id: m.id,
        type: m.type,
        category: m.category,
        amount: m.amount,
        createdAt: this.toLocalDateTime(m.createdAt),
        description: m.description,
        origen: m.origen ?? '',
        destino: m.destino ?? '',
        clientName: m.clientName ?? '',
        clientDocument: m.clientDocument ?? '',
        loanRequestId: m.loanRequestId ?? '',
        affectsBalance: m.affectsBalance ? 'Sí' : 'No',
      })),
    );
    
    // --- Cartera ---
    const wsCart = wb.addWorksheet('Cartera');
    wsCart.columns = [
      { header: 'LoanRequestId', key: 'loanRequestId', width: 14 },
      { header: 'ClienteId', key: 'clientId', width: 10 },
      { header: 'Cliente', key: 'clientName', width: 32 },
      { header: 'Desembolsado (solicitado)', key: 'disbursed', width: 20 },
      { header: 'Pagado', key: 'repaid', width: 14 },
      { header: 'Descuentos', key: 'discounts', width: 14 },
      { header: 'Penalidades', key: 'penalties', width: 14 },
      { header: 'Fees', key: 'fees', width: 14 },
      { header: 'Saldo', key: 'outstanding', width: 14 },
      { header: 'Último pago', key: 'lastPaymentAt', width: 22 },
      { header: 'Estatus', key: 'status', width: 12 },
    ];
    wsCart.addRows(
      (data.portfolio?.loans || []).map((l: any) => {
        const desembolsado = l.requestedAmount ?? l.disbursed ?? 0;
        return {
          loanRequestId: l.loanRequestId,
          clientId: l.clientId ?? '',
          clientName: l.clientName ?? '',
          disbursed: desembolsado,
          repaid: l.repaid,
          discounts: l.discounts,
          penalties: l.penalties,
          fees: l.fees,
          outstanding: l.outstanding,
          lastPaymentAt: l.lastPaymentAt ? this.toLocalDateTime(l.lastPaymentAt) : '',
          status: l.status,
        };
      }),
    );
    
    const buffer = await wb.xlsx.writeBuffer();
    return Buffer.from(buffer as ArrayBuffer);
  }
  
  async exportDailyTraceToPDF(userId: number, date: string): Promise<Buffer> {
    const data = await this.getDailyTraceByUser(userId, date);
    
    const PDFMod = await import('pdfkit');
    const PDFDocument: any = (PDFMod as any).default ?? PDFMod;
    
    const doc = new PDFDocument({ size: 'A4', margin: 32 });
    const chunks: Buffer[] = [];
    
    return await new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      
      // Title + resume
      doc.fontSize(16).text('Traza diaria por usuario', { align: 'center' });
      doc.moveDown(0.5);
      doc
      .fontSize(10)
      .text(
        `Fecha: ${data.fecha}  ·  Usuario: ${data.usuario}  ·  Sucursal: ${
          data.branchId ?? '—'
        }`,
      );
      doc.moveDown();
      
      const resumen: Array<[string, any]> = [
        ['Base anterior', data.baseAnterior],
        ['Ingresos del día', data.totalIngresosDia],
        ['Egresos del día', data.totalEgresosDia],
        ['Total final', data.totalFinal],
        ['Cobrado hoy (kpi)', data.kpis?.valorCobradoDia ?? 0],
        ['Clientes en deuda (kpi)', data.kpis?.clientesEnDeuda ?? 0],
        ['Valor en cartera (kpi)', data.kpis?.valorEnCartera ?? 0],
        [
          'Nuevos (cant/monto)',
          `${data.kpis?.clientesNuevos?.cantidad ?? 0} / ${
            data.kpis?.clientesNuevos?.montoPrestado ?? 0
          }`,
        ],
        [
          'Renovados (cant/monto)',
          `${data.kpis?.clientesRenovados?.cantidad ?? 0} / ${
            data.kpis?.clientesRenovados?.montoPrestado ?? 0
          }`,
        ],
      ];
      resumen.forEach(([k, v]) => doc.fontSize(10).text(`${k}: ${v}`));
      
      // Movements
      doc.addPage();
      doc.fontSize(12).text('Movimientos del día');
      doc.moveDown(0.4);
      this.pdfRow(doc, ['ID', 'Tipo', 'Categoría', 'Monto', 'Fecha', 'Descripción'], true);
      (data.movimientos || [])
      .slice(0, 500)
      .forEach((m: any) => {
        this.pdfRow(doc, [
          String(m.id),
          String(m.type),
          String(m.category),
          String(m.amount),
          this.toLocalDateTime(m.createdAt),
          String(m.description ?? ''),
        ]);
      });
      
      // Portfolio (summary)
      doc.addPage();
      doc.fontSize(12).text('Cartera (resumen)');
      doc.moveDown(0.4);
      this.pdfRow(
        doc,
        ['LoanId', 'Cliente', 'Desemb.', 'Pagado', 'Saldo', 'Últ. pago', 'Status'],
        true,
      );
      (data.portfolio?.loans || [])
      .slice(0, 300)
      .forEach((l: any) => {
        this.pdfRow(doc, [
          String(l.loanRequestId),
          (l.clientName ?? '').slice(0, 28),
          String(l.disbursed),
          String(l.repaid),
          String(l.outstanding),
          l.lastPaymentAt ? this.toLocalDateTime(l.lastPaymentAt) : '',
          String(l.status ?? ''),
        ]);
      });
      
      doc.end();
    });
  }
  
  // --- helpers
  private toLocalDateTime(d: Date | string | null | undefined): string {
    if (!d) return '';
    const x = typeof d === 'string' ? new Date(d) : d;
    if (!(x instanceof Date) || isNaN(x.getTime())) return '';
    const y = x.getFullYear();
    const m = String(x.getMonth() + 1).padStart(2, '0');
    const dd = String(x.getDate()).padStart(2, '0');
    const hh = String(x.getHours()).padStart(2, '0');
    const mi = String(x.getMinutes()).padStart(2, '0');
    const ss = String(x.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${dd} ${hh}:${mi}:${ss}`;
  }
  
  private pdfRow(doc: PDFDocument, cells: Array<string | number>, header = false) {
    const widths = [40, 50, 90, 60, 90, 200];
    const usedWidths = widths.slice(0, cells.length);
    const x0 = (doc as any).x as number;
    const y0 = (doc as any).y as number;
    const h = 16;
    
    if (header) {
      doc.save();
      doc
      .rect(x0, y0, usedWidths.reduce((a, b) => a + b, 0), h)
      .fillOpacity(0.1)
      .fill('#000');
      doc.fillOpacity(1).fill('#000');
      doc.restore();
    }
    
    let x = x0;
    cells.forEach((text, i) => {
      const w = usedWidths[i] ?? 80;
      doc.rect(x, y0, w, h).stroke();
      (doc as any).text(String(text ?? ''), x + 3, y0 + 3, { width: w - 6, ellipsis: true });
      x += w;
    });
    
    (doc as any).moveDown(0.1);
    (doc as any).y = y0 + h;
  }
  
  
  /**
  * Exporta a Excel:
  *  - Hoja "Indicadores" (KPIs del día, igual a getDailyTotalsByUser)
  *  - Hoja "Préstamos" (detalle por préstamo con agente, cliente, prestado, pagado, saldo, mora)
  *  - Hoja "Resumen" (totales de cartera activa)
  *
  * Alcance:
  *  - AGENT: solo sus préstamos
  *  - ADMIN/MANAGER: préstamos de la sucursal del usuario
  */
  async exportarPrestamosEIndicadoresPorUsuarioAExcel(userId: number, rawDate: Date | string): Promise<Buffer> {
    // ----------------- Usuario / Rol / Sucursal -----------------
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: { branch: true },
    });
    if (!user?.branch?.id) throw new BadRequestException('El usuario no tiene sucursal');
    
    const branchId = user.branch.id;
    const role = String(user.role ?? '').toUpperCase();
    const isAdminOrManager = role === 'ADMIN' || role === 'MANAGER';
    
    // ----------------- Rango del día -----------------
    const start =
    typeof rawDate === 'string'
    ? (() => {
      const [y, m, d] = rawDate.split('-').map(Number);
      return new Date(y, m - 1, d, 0, 0, 0, 0);
    })()
    : new Date(new Date(rawDate).setHours(0, 0, 0, 0));
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    
    const asStr = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      return `${y}-${m}-${dd} ${hh}:${mi}:${ss}`;
    };
    const endStr = asStr(end);
    
    const lower = (s?: string) => String(s ?? '').toLowerCase();
    const esPrestamoActivo = (s?: string) => {
      const st = lower(s);
      return st === 'funded' || st === 'renewed';
    };
    const tipoTx = (t: any) =>
      lower((t?.type ?? t?.transactionType ?? t?.Transactiontype) as string);
    
    // ----------------- Indicadores (reutiliza tu API) -----------------
    const tiles = await this.getDailyTotalsByUser(userId, start);
    const pick = (label: string) => tiles.find((t: any) => t.label === label);
    const kpiCajaAnterior = pick('Caja anterior')?.value ?? 0;
    const kpiEntraCaja   = pick('Entra caja')?.value ?? 0;
    const kpiCobro       = pick('Cobro')?.value ?? 0;
    const kpiPrestamos   = pick('Préstamos')?.value ?? 0;
    const kpiGastos      = pick('Gastos')?.value ?? 0;
    const kpiCajaReal    = pick('Caja real')?.value ?? 0;
    const kpiRenovados   = pick('Renovados')?.value ?? 0;
    const kpiRenovCant   = pick('Renovados')?.amount ?? 0;
    const kpiNuevos      = pick('Nuevos')?.value ?? 0;
    const kpiNuevosCant  = pick('Nuevos')?.amount ?? 0;
    
    // ----------------- Préstamos dentro del alcance -----------------
    const lrQB = this.loanRequestRepo
    .createQueryBuilder('lr')
    .leftJoinAndSelect('lr.client', 'client')
    .leftJoinAndSelect('lr.agent', 'agent');
    
    if (isAdminOrManager) {
      lrQB.where('agent.branchId = :branchId', { branchId });
    } else {
      lrQB.where('agent.id = :userId', { userId });
    }
    
    const prestamos = await lrQB.orderBy('lr.createdAt', 'DESC').getMany();
    
    // Transacciones hasta fin de día para calcular Pagado a la fecha
    const idsPrestamo = prestamos.map((l) => l.id);
    let txs: LoanTransaction[] = [];
    if (idsPrestamo.length) {
      txs = await this.loanTransactionRepo.find({
        where: {
          date: Raw((alias) => `${alias} <= :end`, { end: endStr }),
          loanRequest: { id: In(idsPrestamo) },
        },
        relations: { loanRequest: true },
        order: { date: 'ASC', id: 'ASC' },
      });
    }
    
    const pagadoPorPrestamo = new Map<number, number>();
    for (const tx of txs) {
      const lrId = (tx as any)?.loanRequest?.id;
      if (!lrId) continue;
      const kind = tipoTx(tx);
      if (kind === 'repayment' || kind === 'payment') {
        const amt = Number((tx as any).amount ?? 0);
        pagadoPorPrestamo.set(lrId, (pagadoPorPrestamo.get(lrId) ?? 0) + (isFinite(amt) ? amt : 0));
      }
    }
    
    const diasMoraDe = (fechaFin?: Date | string | null) => {
      const d = fechaFin ? new Date(fechaFin) : null;
      return d && end > d ? Math.floor((end.getTime() - d.getTime()) / 86_400_000) : 0;
    };
    
    type Fila = {
      idSolicitud: number;
      estado: string;
      creadoEn: Date | null;
      venceEn: Date | null;
      tipo: string | null;
      modalidad: string | null;
      diaPago: string | null;
      
      idCliente: number | null;
      cliente: string | null;
      documento: string | null;
      
      idAgente: number | null;
      agente: string | null;
      idSucursal: number | null;
      
      solicitado: number;
      desembolsado: number;
      pagadoAlDia: number;
      saldo: number;
      diasMora: number;
    };
    
    const filas: Fila[] = [];
    let totalActivosDesemb = 0;
    let totalActivosPagado = 0;
    let totalActivosSaldo = 0;
    let cantActivos = 0;
    
    for (const lr of prestamos) {
      const desembolsado = Number((lr as any).amount ?? 0);
      const pagado = pagadoPorPrestamo.get(lr.id) ?? 0;
      const saldo = Math.max(0, desembolsado - pagado);
      const mora = diasMoraDe((lr as any).endDateAt);
      
      const agente = (lr as any).agent;
      const cliente = (lr as any).client;
      const idSucursal = (agente as any)?.branchId ?? null;
      
      filas.push({
        idSolicitud: lr.id,
        estado: (lr as any).status ?? '',
        creadoEn: (lr as any).createdAt ?? null,
        venceEn: (lr as any).endDateAt ?? null,
        tipo: (lr as any).type ?? null,
        modalidad: (lr as any).mode ?? null,
        diaPago: (lr as any).paymentDay ?? null,
        
        idCliente: cliente?.id ?? null,
        cliente: cliente?.name ?? cliente?.fullName ?? null,
        documento:
        cliente?.document ??
        (cliente as any)?.dni ??
        (cliente as any)?.cedula ??
        (cliente as any)?.identification ??
        null,
        
        idAgente: agente?.id ?? null,
        agente: agente?.name ?? null,
        idSucursal: idSucursal,
        
        solicitado: Number((lr as any).requestedAmount ?? (lr as any).amount ?? 0),
        desembolsado,
        pagadoAlDia: pagado,
        saldo,
        diasMora: mora,
      });
      
      if (esPrestamoActivo((lr as any).status)) {
        cantActivos += 1;
        totalActivosDesemb += desembolsado;
        totalActivosPagado += pagado;
        totalActivosSaldo += saldo;
      }
    }
    
    // ----------------- Construir Excel (en español) -----------------
    const ExcelMod = await import('exceljs');
    const ExcelJS: any = (ExcelMod as any).default ?? ExcelMod;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Servicio de Caja';
    wb.created = new Date();
    
    // Hoja: Indicadores
    const wsKPI = wb.addWorksheet('Indicadores');
    wsKPI.columns = [
      { header: 'Métrica', key: 'label', width: 28 },
      { header: 'Valor', key: 'value', width: 18 },
      { header: 'Cantidad', key: 'amount', width: 12 },
    ];
    for (const t of tiles) {
      wsKPI.addRow({
        label: t.label,
        value: t.value ?? 0,
        amount: t.amount ?? '',
      });
    }
    
    // Hoja: Resumen
    const wsResumen = wb.addWorksheet('Resumen');
    wsResumen.columns = [
      { header: 'Campo', key: 'k', width: 32 },
      { header: 'Valor', key: 'v', width: 22 },
    ];
    wsResumen.addRows([
      { k: 'Fecha', v: asStr(start).split(' ')[0] },
      { k: 'Usuario', v: userId },
      { k: 'Rol', v: role },
      { k: 'Sucursal (branchId)', v: branchId },
      { k: 'Préstamos activos (funded|renewed)', v: cantActivos },
      { k: 'Desembolsado activos', v: totalActivosDesemb },
      { k: 'Pagado activos', v: totalActivosPagado },
      { k: 'Saldo activos', v: totalActivosSaldo },
      { k: 'Caja anterior', v: kpiCajaAnterior },
      { k: 'Entra caja', v: kpiEntraCaja },
      { k: 'Cobro', v: kpiCobro },
      { k: 'Préstamos', v: kpiPrestamos },
      { k: 'Gastos', v: kpiGastos },
      { k: 'Caja real', v: kpiCajaReal },
      { k: 'Renovados (monto)', v: kpiRenovados },
      { k: 'Renovados (cantidad)', v: kpiRenovCant },
      { k: 'Nuevos (monto)', v: kpiNuevos },
      { k: 'Nuevos (cantidad)', v: kpiNuevosCant },
    ]);
    
    // Hoja: Préstamos (detalle)
    const wsPrestamos = wb.addWorksheet('Préstamos');
    wsPrestamos.columns = [
      { header: 'ID solicitud', key: 'idSolicitud', width: 14 },
      { header: 'Estado', key: 'estado', width: 12 },
      { header: 'Creado en', key: 'creadoEn', width: 20 },
      { header: 'Vence en', key: 'venceEn', width: 20 },
      { header: 'Tipo', key: 'tipo', width: 12 },
      { header: 'Modalidad', key: 'modalidad', width: 12 },
      { header: 'Día de pago', key: 'diaPago', width: 12 },
      
      { header: 'ID cliente', key: 'idCliente', width: 10 },
      { header: 'Cliente', key: 'cliente', width: 28 },
      { header: 'Documento', key: 'documento', width: 18 },
      
      { header: 'ID agente', key: 'idAgente', width: 10 },
      { header: 'Agente', key: 'agente', width: 22 },
      { header: 'ID sucursal', key: 'idSucursal', width: 10 },
      
      { header: 'Solicitado', key: 'solicitado', width: 16 },
      { header: 'Desembolsado', key: 'desembolsado', width: 16 },
      { header: 'Pagado a la fecha', key: 'pagadoAlDia', width: 18 },
      { header: 'Saldo', key: 'saldo', width: 14 },
      { header: 'Días mora', key: 'diasMora', width: 10 },
    ];
    
    const fmtDT = (d: Date | string | null | undefined): string => {
      if (!d) return '';
      const x = d instanceof Date ? d : new Date(d);
      if (!(x instanceof Date) || isNaN(x.getTime())) return '';
      const y = x.getFullYear();
      const m = String(x.getMonth() + 1).padStart(2, '0');
      const dd = String(x.getDate()).padStart(2, '0');
      const hh = String(x.getHours()).padStart(2, '0');
      const mi = String(x.getMinutes()).padStart(2, '0');
      const ss = String(x.getSeconds()).padStart(2, '0');
      return `${y}-${m}-${dd} ${hh}:${mi}:${ss}`;
    };
    wsPrestamos.addRows(
      filas.map((r) => ({
        ...r,
        creadoEn: fmtDT(r.creadoEn),
        venceEn: fmtDT(r.venceEn),
      })),
    );
    
    // Totales (solo activos) al final
    const filasActivas = filas.filter((r) => esPrestamoActivo(r.estado));
    wsPrestamos.addRow({});
    wsPrestamos.addRow({
      cliente: 'TOTALES (solo activos)',
      solicitado: filasActivas.reduce((s, r) => s + (r.solicitado || 0), 0),
      desembolsado: filasActivas.reduce((s, r) => s + (r.desembolsado || 0), 0),
      pagadoAlDia: filasActivas.reduce((s, r) => s + (r.pagadoAlDia || 0), 0),
      saldo: filasActivas.reduce((s, r) => s + (r.saldo || 0), 0),
    });
    
    const buffer = await wb.xlsx.writeBuffer();
    return Buffer.from(buffer as ArrayBuffer);
  }
  
}
