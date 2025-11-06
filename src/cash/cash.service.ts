import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CashMovement, CashMovementType } from 'src/entities/cash-movement.entity';
import { CashMovementCategory } from 'src/entities/cash-movement-category.enum';
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
  async getMovements(
    branchId: number,
    limit = 10,
    page = 1,
    search?: string,
    date?: string,
  ) {
    const qb = this.cashRepo
      .createQueryBuilder('movement')
      .where('movement.branchId = :branchId', { branchId });

    if (search && typeof search === 'string' && search.trim()) {
      qb.andWhere('LOWER(movement.reference) LIKE :search', {
        search: `%${search.toLowerCase().trim()}%`,
      });
    }

    if (date) {
      const day = typeof date === 'string' ? date : format(date, 'yyyy-MM-dd');
      qb.andWhere('DATE(movement.createdAt) = :day', { day });
    }

    qb.orderBy('movement.createdAt', 'DESC')
      .skip((Math.max(1, page) - 1) * Math.max(1, limit))
      .take(Math.max(1, limit));

    const [rows, total] = await qb.getManyAndCount();

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

    return {
      data: rows.map((m) => ({
        id: m.id,
        category: m.category,
        amount: m.amount,
        createdAt: m.createdAt,
        description: m.reference,
        origen: m.origenId ? usersById.get(m.origenId) ?? { id: m.origenId } : null,
        destino: m.destinoId ? usersById.get(m.destinoId) ?? { id: m.destinoId } : null,
      })),
      total,
      page: Math.max(1, page),
      limit: Math.max(1, limit),
    };
  }

  /**
   * Dashboard totals by branch and date.
   * (Optionally we can exclude admin-made disbursements from KPIs. Kept excluded for coherence.)
   */
  async getDailyTotals(branchId: number, rawDate: Date | string) {
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

    const [movements, previousMovements] = await Promise.all([
      this.cashRepo.find({
        where: {
          branch: { id: branchId },
          createdAt: Between(start, end),
        },
      }),
      this.cashRepo.find({
        where: {
          branch: { id: branchId },
          createdAt: LessThan(start),
        },
      }),
    ]);

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
      movements
        .filter((m) => m.category === cat)
        .reduce((s, m) => s + +m.amount, 0);

    const entraCaja = byCategory('ENTRADA_GERENCIA');
    const totalCobros = byCategory('COBRO_CLIENTE');
    const totalDesembolsos = byCategory('PRESTAMO');
    const totalGastos = byCategory('GASTO_PROVEEDOR');

    // Optional coherence: exclude admin-made disbursements from branch KPIs
    const disbursements = await this.loanTransactionRepo.find({
      where: {
        Transactiontype: TransactionType.DISBURSEMENT,
        date: Between(start, end),
        loanRequest: { agent: { branch: { id: branchId } } },
        isAdminTransaction: false as any,
      },
      relations: { loanRequest: { client: true, agent: { branch: true } } },
    });

    const penalties = await this.loanTransactionRepo.find({
      where: {
        Transactiontype: TransactionType.PENALTY,
        date: Between(start, end),
        loanRequest: { agent: { branch: { id: branchId } } },
      },
      relations: { loanRequest: { client: true, agent: { branch: true } } },
    });

    const renewedByRequest = new Map<number, LoanRequest>();
    for (const pen of penalties) {
      const req = pen.loanRequest as LoanRequest;
      if (!renewedByRequest.has(req.id)) renewedByRequest.set(req.id, req);
    }

    const totalRenovados = [...renewedByRequest.values()].reduce(
      (sum, req) => sum + +(req.requestedAmount ?? req.amount ?? 0),
      0,
    );
    const countRenovados = renewedByRequest.size;

    const nuevosHoy = movements.filter(
      (m) => m.type === 'SALIDA' && m.category === 'PRESTAMO',
    );
    const totalNuevos = nuevosHoy.reduce((sum, m) => sum + +m.amount, 0);
    const countNuevos = nuevosHoy.length;

    return [
      { label: 'Caja anterior', value: cajaAnterior, trend: '' },
      { label: 'Entra caja', value: entraCaja, trend: 'increase' },
      { label: 'Cobro', value: totalCobros, trend: 'increase' },
      { label: 'Préstamos', value: totalDesembolsos, trend: 'decrease' },
      { label: 'Gastos', value: totalGastos, trend: 'decrease' },
      { label: 'Caja real', value: cajaReal, trend: '' },
      { label: 'Renovados', value: totalRenovados, trend: 'increase', amount: countRenovados },
      { label: 'Nuevos', value: totalNuevos, trend: 'increase', amount: countNuevos },
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
    { label: 'Cobro', value: totalCobros, trend: 'increase' },
    { label: 'Préstamos', value: totalDesembolsos, trend: 'decrease' },
    { label: 'Gastos', value: totalGastos, trend: 'decrease', hideForAgent: true },
    { label: 'Caja real', value: realCash },
    { label: 'Renovados', value: totalRenovados, trend: 'increase', amount: countRenovados },
    { label: 'Nuevos', value: totalNuevos, trend: 'increase', amount: countNuevos },
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

    const [historyAll, todayAll] = await Promise.all([
      this.cashRepo.find({
        where: { createdAt: Raw((alias) => `${alias} < :start`, { start: startStr }) },
        relations: { transaction: { loanRequest: { agent: true, client: true } } },
      }),
      this.cashRepo.find({
        where: {
          createdAt: Raw((alias) => `${alias} BETWEEN :start AND :end`, {
            start: startStr,
            end: endStr,
          }),
        },
        relations: { transaction: { loanRequest: { agent: true, client: true } } },
      }),
    ]);

    const history = historyAll.filter(affectsUserForBalance);
    const today = todayAll.filter(affectsUserForBalance);

    const baseAnterior = history.reduce(
      (tot, m) => (m.type === T.ENTRADA ? tot + +m.amount : tot - +m.amount),
      0,
    );

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
        ownerIdForNonTransfer(m) === userId,
    );
    const gastos = sumWhere(
      (m) =>
        m.type === T.SALIDA &&
        m.category === C.GASTO_PROVEEDOR &&
        ownerIdForNonTransfer(m) === userId,
    );
    const cobros = sumWhere(
      (m) =>
        m.type === T.ENTRADA &&
        m.category === C.COBRO_CLIENTE &&
        ownerIdForNonTransfer(m) === userId,
    );

    const toStatus = (lr?: LoanRequest) => String(lr?.status ?? '').trim().toLowerCase();

    // Key: only count agent-made disbursements (exclude admin-made)
    const disbursalsToday = await this.loanTransactionRepo.find({
      where: {
        Transactiontype: Raw((alias) => `LOWER(${alias}) = 'disbursement'`),
        date: Raw((alias) => `${alias} BETWEEN :start AND :end`, { start: startStr, end: endStr }),
        loanRequest: { agent: { id: userId } },
        isAdminTransaction: false as any,
      },
      relations: { loanRequest: { client: true } },
    });

    let totalNuevos = 0;
    let totalRenovados = 0;
    const NUEVO_CLIENTES = new Set<number>();
    const RENOV_CLIENTES = new Set<number>();

    for (const tx of disbursalsToday) {
      const lr = tx.loanRequest as LoanRequest;
      const amt = Number((tx as any).amount ?? 0);
      const st = toStatus(lr);
      const clientId = (lr as any)?.client?.id;

      if (st === 'renewed') {
        totalRenovados += amt;
        if (clientId) RENOV_CLIENTES.add(clientId);
      } else {
        totalNuevos += amt;
        if (clientId) NUEVO_CLIENTES.add(clientId);
      }
    }

    const totalIngresosDia = ingresosNoTransfer + transferIn + cobros;
    const totalEgresosDia = transferOut + gastos + totalNuevos + totalRenovados;
    const totalFinal = baseAnterior + totalIngresosDia - totalEgresosDia;

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
    const paymentsToday = await this.loanTransactionRepo.find({
      where: {
        date: Raw((alias) => `${alias} BETWEEN :start AND :end`, {
          start: startStr,
          end: endStr,
        }),
        loanRequest: { agent: { id: userId } },
        isAdminTransaction: false as any, // exclude admin-made payments from agent KPI
      },
      relations: { loanRequest: true },
    });
    const valorCobradoDia = paymentsToday
      .filter((t) => {
        const s = String(t.Transactiontype).toLowerCase();
        return s === 'repayment' || s === 'payment';
      })
      .reduce((s, t) => s + +((t as any).amount ?? 0), 0);

    return {
      fecha: fmtYMD(start),
      usuario: userId,
      branchId,
      baseAnterior,
      totalIngresosDia,
      totalEgresosDia,
      totalFinal,

      ingresos: { ingresosNoTransfer, transferIn, cobros },
      egresos: { transferOut, prestamosNuevos: totalNuevos, gastos, renovados: totalRenovados },

      movimientos: movimientosDia,

      kpis: {
        valorEnCartera: portfolio.outstandingTotal,
        clientesEnDeuda: portfolio.clientsCount,
        baseAnterior,
        valorCobradoDia,
        clientesNuevos: { cantidad: NUEVO_CLIENTES.size, montoPrestado: totalNuevos },
        clientesRenovados: { cantidad: RENOV_CLIENTES.size, montoPrestado: totalRenovados },
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
}
