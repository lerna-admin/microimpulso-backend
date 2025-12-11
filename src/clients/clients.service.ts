import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client } from '../entities/client.entity';
import { LoanRequest, LoanRequestStatus } from 'src/entities/loan-request.entity';
import { ChatMessage } from 'src/entities/chat-message.entity';
import { User } from 'src/entities/user.entity';
import { Country } from 'src/entities/country.entity';

type ClientListStatus = 'active' | 'inactive' | 'approved' | 'rejected';

@Injectable()
export class ClientsService {
  constructor(
    @InjectRepository(Client)
    private readonly clientRepository: Repository<Client>,

    @InjectRepository(LoanRequest)
    private readonly loanRequestRepository: Repository<LoanRequest>,

    @InjectRepository(ChatMessage)
    private readonly chatMessageRepository: Repository<ChatMessage>,

    // ⬇️ NUEVO: para scoping por rol/branch.country
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,

    // ⬇️ NUEVO: para validar que el country exista en create/update
    @InjectRepository(Country)
    private readonly countryRepository: Repository<Country>,
  ) {}

  private readonly ACTIVE_LOAN_STATUSES = new Set<string>([
    LoanRequestStatus.FUNDED,
    LoanRequestStatus.RENEWED,
  ]);

  private normalizeStatus(value?: string): string {
    return String(value ?? '').trim().toLowerCase();
  }

  private loanHasServiceAmount(loan?: LoanRequest | null): boolean {
    return Number(loan?.requestedAmount ?? 0) > 1;
  }

  private getLoanListingStatus(loan?: LoanRequest | null): ClientListStatus {
    if (!loan) return 'inactive';
    const normalized = this.normalizeStatus(loan.status);
    if (normalized === LoanRequestStatus.REJECTED) {
      return 'rejected';
    }
    if (normalized === LoanRequestStatus.APPROVED) {
      return 'approved';
    }
    if (this.ACTIVE_LOAN_STATUSES.has(normalized) && this.loanHasServiceAmount(loan)) {
      return 'active';
    }
    if (normalized === LoanRequestStatus.COMPLETED) {
      return 'inactive';
    }
    return 'inactive';
  }

  private getClientListingStatus(loans?: LoanRequest[]): 'ACTIVE' | 'INACTIVE' | 'REJECTED' | 'PROSPECT' {
    if (!loans || loans.length === 0) return 'PROSPECT';
    let hasActive = false;
    let hasRejected = false;
    for (const loan of loans) {
      const status = this.getLoanListingStatus(loan);
      if (status === 'active') {
        hasActive = true;
      } else if (status === 'rejected') {
        hasRejected = true;
      }
    }
    if (hasActive) return 'ACTIVE';
    if (hasRejected) return 'REJECTED';
    return 'INACTIVE';
  }

  private async buildChatStatsMap(): Promise<Map<number, { total: number; outgoing: number }>> {
    const rawChatStats = await this.chatMessageRepository
      .createQueryBuilder('msg')
      .select('msg.clientId', 'clientId')
      .addSelect(`SUM(CASE WHEN msg.direction = 'OUTGOING' THEN 1 ELSE 0 END)`, 'outgoingCount')
      .addSelect('COUNT(*)', 'totalCount')
      .where('msg.clientId IS NOT NULL')
      .groupBy('msg.clientId')
      .getRawMany();

    const chatStatsMap = new Map<number, { total: number; outgoing: number }>();
    for (const row of rawChatStats) {
      const clientId = Number(row.clientId);
      if (!clientId) continue;
      chatStatsMap.set(clientId, {
        total: Number(row.totalCount ?? row.total ?? row.count ?? 0),
        outgoing: Number(row.outgoingCount ?? 0),
      });
    }
    return chatStatsMap;
  }
  
  // ============================================================
  // ===============  HELPERS CUSTOM FIELDS  ====================
  // ============================================================
  /**
  * Normaliza y valida el arreglo de customFields.
  * Estructura final: { key: string; type: 'text'|'number'|'link'; value: any }[]
  */
  private normalizeCustomFields(
    input: any,
  ): Array<{ key: string; type: 'text' | 'number' | 'link'; value: any }> {
    const arr = Array.isArray(input) ? input : [];
    const out: Array<{ key: string; type: 'text' | 'number' | 'link'; value: any }> = [];
    
    for (const it of arr) {
      const key = String(it?.key ?? '').trim();
      const type = String(it?.type ?? '').trim() as 'text' | 'number' | 'link';
      let value: any = it?.value;
      
      if (!key) continue;
      if (!['text', 'number', 'link'].includes(type)) continue;
      
      if (type === 'number') {
        const n = Number(value);
        if (!Number.isFinite(n)) continue;
        value = n;
      } else if (type === 'link') {
        const s = String(value ?? '').trim();
        if (!/^https?:\/\//i.test(s)) continue; // acepta http/https
        value = s;
      } else {
        value = String(value ?? '').trim();
      }
      
      out.push({ key, type, value });
    }
    return out;
  }
  
  // ============================================================
  // =======================  SEARCH  ===========================
  // ============================================================
  /**
  * Free-text search across multiple Client fields.
  * - Case-insensitive using LOWER(..) LIKE :term
  * - Matches: name, phone, email, document
  * - Optional filter by `lead`
  */
  async search(
    q: string,
    opts: { limit?: number; offset?: number; lead?: boolean } = {},
  ): Promise<{ total: number; limit: number; offset: number; items: Client[] }> {
    if (!q || !q.trim())
      throw new BadRequestException('Missing required search string "q".');
    
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const leadFilter = typeof opts.lead === 'boolean' ? opts.lead : undefined;
    
    const qTrim = q.trim();
    const term = `%${qTrim.toLowerCase()}%`;
    const digits = qTrim.replace(/\D/g, '');
    
    const qb = this.clientRepository.createQueryBuilder('c');
    const like = (col: string) => `LOWER(${col}) LIKE :term`;
    
    qb.where(like('c.name'))
    .orWhere(like('c.phone'))
    .orWhere(like('c.email'))
    .orWhere(like('c.document'))
    .setParameter('term', term);
    
    if (digits.length >= 3) {
      qb.orWhere(
        `REPLACE(REPLACE(REPLACE(c.phone, ' ', ''), '-', ''), '+', '') LIKE :digits`,
        { digits: `%${digits}%` },
      );
    }
    
    if (typeof leadFilter === 'boolean')
      qb.andWhere('c.lead = :lead', { lead: leadFilter });
    
    qb.leftJoinAndSelect('c.agent', 'agent')
    .orderBy('c.updatedAt', 'DESC')
    .take(limit)
    .skip(offset);
    
    const [items, total] = await qb.getManyAndCount();
    return { total, limit, offset, items };
  }
  
  // ============================================================
  // =======================  UPDATE  ===========================
  // ============================================================
 async update(id: number, data: any): Promise<Client> {
  const client = await this.clientRepository.findOne({
    where: { id },
    relations: ['agent'], // lo tuyo
  });
  if (!client) {
    throw new NotFoundException('Client not found');
  }

  // Campos permitidos (agregamos countryId)
  const allowedFields = [
    'name',
    'phone',
    'email',
    'document',
    'documentType',
    'address',
    'status',
    'notes',
    'notEligible',
    'lead',
    'phone2',
    'address2',
    'referenceName',
    'referencePhone',
    'referenceRelationship',
    'customFields',
    'city',
    'countryId', // ⬅️ NUEVO
  ];

  // ⬇️ Si viene countryId, validar existencia
  if ('countryId' in data) {
    const newCountryId = Number(data.countryId);
    if (!Number.isFinite(newCountryId)) {
      throw new BadRequestException('countryId inválido.');
    }
    const exists = await this.countryRepository.exist({ where: { id: newCountryId } });
    if (!exists) throw new BadRequestException('El país indicado no existe.');

    // (Opcional) bloqueo seguro: si hay loans activos con agente de otro país
    // podrías impedir el cambio. Aquí solo verificamos y permitimos;
    // si quieres bloquear, descomenta:
    //
    // const hasMismatch = await this.loanRequestRepository.createQueryBuilder('loan')
    //   .leftJoin('loan.agent', 'agent')
    //   .leftJoin('agent.branch', 'branch')
    //   .where('loan.clientId = :cid', { cid: id })
    //   .andWhere('LOWER(loan.status) IN (:...active)', { active: ['funded','renewed'] })
    //   .andWhere('branch.countryId <> :nc', { nc: newCountryId })
    //   .getExists();
    // if (hasMismatch) {
    //   throw new ConflictException('No puedes cambiar el país: hay préstamos activos con agentes de otro país.');
    // }
  }

  // Aplicar cambios permitidos
  for (const key of allowedFields) {
    if (key in data) {
      if (key === 'customFields') {
        client.customFields = this.normalizeCustomFields(data.customFields);
      } else {
        // @ts-ignore
        client[key] = data[key];
      }
    }
  }

  // Asegurar consistencia mínima
  if ((client as any).branchId) {
    // el cliente NO debe tener branch
    (client as any).branchId = null;
  }

  client.updatedAt = new Date();
  return this.clientRepository.save(client);
}

  
  // ============================================================
  // ========================  FIND ALL  ========================
  // ============================================================
async findAllORI(
  limit: number = 10,
  page: number = 1,
  filters: {
    status?: ClientListStatus;
    document?: string;
    name?: string;
    mode?: string;
    type?: string;
    paymentDay?: string;
    agent?: number;
    branch?: number;     // branch del agente (filtro adicional opcional)
    countryId?: number;  // país del cliente (filtro adicional opcional)
    distinct?: boolean;
  } = {},
  requesterUserId: number,
): Promise<any> {
  // ───────────────────────────────────────────────────────────────
  // 0) Scope por rol
  // ───────────────────────────────────────────────────────────────
  const requester = await this.userRepository.findOne({
    where: { id: requesterUserId },
    relations: ['branch', 'managerCountry'],
  });
  if (!requester) throw new BadRequestException('Usuario solicitante no existe.');

  const role = String(requester.role).toUpperCase();
  let adminBranchId: number | null = null;
  let adminBranchCountryId: number | null = null;
  let managerCountryId: number | null = null;

  if (role === 'ADMIN') {
    adminBranchId = (requester as any)?.branch?.id ?? (requester as any)?.branchId ?? null;
    adminBranchCountryId = (requester as any)?.branch?.countryId ?? null;
    if (!adminBranchId) throw new BadRequestException('El ADMIN no tiene branch asignada.');
  } else if (role === 'MANAGER') {
    managerCountryId =
      (requester as any)?.managerCountryId ??
      (requester as any)?.managerCountry?.id ??
      null;
    if (managerCountryId == null) {
      throw new BadRequestException('No se pudo determinar managerCountryId para el MANAGER.');
    }
  } else if (role !== 'AGENT') {
    throw new BadRequestException('Rol no soportado. Use AGENT | ADMIN | MANAGER.');
  }

  // ───────────────────────────────────────────────────────────────
  // Helpers para normalizar strings (tildes/espacios)
  // ───────────────────────────────────────────────────────────────
  const norm = (s?: string) =>
    String(s ?? '')
      .normalize('NFD')
      // quita diacríticos
      .replace(/\p{Diacritic}/gu, '')
      // colapsa espacios
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  const normIncludes = (haystack?: string, needle?: string) => {
    const h = norm(haystack);
    const n = norm(needle);
    return n ? h.includes(n) : true;
  };

  // ───────────────────────────────────────────────────────────────
  // 1) Traer LOANS (con country) para filtrar como hacías
  // ───────────────────────────────────────────────────────────────
  const loans = await this.loanRequestRepository.find({
    relations: { client: { country: true }, transactions: true, agent: { branch: true } },
    order: { createdAt: 'DESC' },
  });

  // ───────────────────────────────────────────────────────────────
  // 2) Helpers de estado
  // ───────────────────────────────────────────────────────────────
  const lower = (s?: string) => String(s ?? '').toLowerCase();
  const isActiveLoan = (loan: LoanRequest) => this.getLoanListingStatus(loan) === 'active';
  const txTypeOf = (t: any) =>
    lower((t?.type ?? t?.transactionType ?? t?.Transactiontype) as string);
  const now = new Date();
  const daysLateOf = (end?: Date | string | null) => {
    const d = end ? new Date(end) : null;
    return d && now > d ? Math.floor((now.getTime() - d.getTime()) / 86_400_000) : 0;
  };
  // Mes actual y mes anterior (para NP por mes)
  const currentMonth = now.getMonth();       // 0-11
  const currentYear  = now.getFullYear();
  const prevMonth    = currentMonth === 0 ? 11 : currentMonth - 1;
  const prevYear     = currentMonth === 0 ? currentYear - 1 : currentYear;

  // ───────────────────────────────────────────────────────────────
  // 3) Agregadores
  // ───────────────────────────────────────────────────────────────
  let totalActiveAmountBorrowed = 0;
  let totalActiveRepayment = 0;
  const activeClientIds = new Set<number>();
  let mora15 = 0;
  let critical20 = 0;
  let noPayment30 = 0;
  let delinquentClients = 0;
  // Máxima mora por cliente (solo loans activos)
  const clientMaxDaysLate = new Map<number, number>();
  // Clientes cuyo endDateAt está en el mes anterior (NP)
  const npClientIds = new Set<number>();

  const items: any[] = [];
  const seenClientIds = new Set<number>();

  // ───────────────────────────────────────────────────────────────
  // 4) Iterar LOANS (tu lógica), usando normIncludes para name/doc
  // ───────────────────────────────────────────────────────────────
  for (const loan of loans) {
    const client = loan.client;
    const agent  = loan.agent;
    const branch = agent?.branch as any;
    if (!client || !agent || !branch) continue;

    // Scope
    if (role === 'AGENT') {
      if (agent.id !== requester.id) continue;
    } else if (role === 'ADMIN') {
      if (branch.id !== adminBranchId) continue;
    } else if (role === 'MANAGER') {
      if ((branch as any).countryId !== managerCountryId) continue;
    }

    // Filtros
    if (filters.countryId && (client.country?.id ?? null) !== filters.countryId) continue;
    if (filters.branch && branch.id !== filters.branch) continue;
    if (filters.agent && agent.id !== filters.agent) continue;
    if (filters.document && !normIncludes(client.document, filters.document)) continue;
    if (filters.name && !normIncludes(client.name, filters.name)) continue;

    const derivedStatus: ClientListStatus = this.getLoanListingStatus(loan);

    if (filters.status && filters.status !== derivedStatus) continue;

    if (filters.mode && String(loan.mode) !== filters.mode) continue;
    if (filters.type && loan.type !== filters.type) continue;
    if (filters.paymentDay && loan.paymentDay !== filters.paymentDay) continue;

    // Métricas
    const amountBorrowed  = Number(loan.amount ?? 0);
    const totalRepayment  = (loan.transactions ?? [])
      .filter((t) => txTypeOf(t) === 'repayment' && t?.amount != null)
      .reduce((s, t) => s + Number(t?.amount ?? 0), 0);
    const remainingAmount = Math.max(0, amountBorrowed - totalRepayment);
    const daysLate        = daysLateOf(loan.endDateAt);
    const endDate         = loan.endDateAt ? new Date(loan.endDateAt as any) : null;

    if (derivedStatus === 'active') {
      totalActiveAmountBorrowed += amountBorrowed;
      totalActiveRepayment     += totalRepayment;
      if (client.id) activeClientIds.add(client.id);

      if (daysLate > 0 && client.id) {
        const prev = clientMaxDaysLate.get(client.id) ?? 0;
        if (daysLate > prev) {
          clientMaxDaysLate.set(client.id, daysLate);
        }
      }

      // NP: préstamos activos con endDateAt en el mes anterior
      if (endDate && client.id) {
        const y = endDate.getFullYear();
        const m = endDate.getMonth(); // 0-11
        if (y === prevYear && m === prevMonth) {
          npClientIds.add(client.id);
        }
      }
    }

    const lastTransaction = (loan.transactions ?? [])
      .filter(t => txTypeOf(t) === 'repayment' && t?.date)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    items.push({
      client,
      agent: { id: agent.id, name: agent.name },
      loanRequest: {
        id: loan.id,
        status: loan.status,
        amount: loan.amount,
        requestedAmount: loan.requestedAmount,
        createdAt: loan.createdAt,
        updatedAt: loan.updatedAt,
        type: loan.type,
        mode: loan.mode,
        mora: loan.mora,
        endDateAt: loan.endDateAt,
        paymentDay: loan.paymentDay,
        transactions: loan.transactions,
        latestPayment: lastTransaction[0] ?? null,
      },
      totalRepayment,
      amountBorrowed,
      remainingAmount,
      daysLate,
      status: derivedStatus,
    });

    if (client.id) seenClientIds.add(client.id);
  }

  // ───────────────────────────────────────────────────────────────
  // 4.b) CLIENTES SIN LOANS que coinciden por NAME (insensible a tildes)
  //     Incluímos aunque no tengan agent/branch/country
  //     (si status=rejected, no aplican por definición al no tener loans)
  // ───────────────────────────────────────────────────────────────
  const mustIncludeNoLoanByName = Boolean((filters.name ?? '').trim()) && filters.status !== 'rejected';
  if (mustIncludeNoLoanByName) {
    const cq = this.clientRepository.createQueryBuilder('c')
      .leftJoinAndSelect('c.agent', 'agent')
      .leftJoinAndSelect('agent.branch', 'branch')
      .leftJoinAndSelect('c.country', 'country')
      .leftJoin('c.loanRequests', 'lr')
      .where('lr.id IS NULL'); // sin loans

    // Scope permisivo con NULLs:
    if (role === 'AGENT') {
      // agente dueño o sin agente
      cq.andWhere('(agent.id = :reqId OR agent.id IS NULL)', { reqId: requester.id });
    } else if (role === 'ADMIN') {
      // branch del admin, o sin agente (sin requerir país; si quieres, limita por país)
      cq.andWhere('(branch.id = :bId OR agent.id IS NULL)', { bId: adminBranchId });
    } else if (role === 'MANAGER') {
      // branches de su país, o sin agente (sin requerir país; si quieres, limita por país=managerCountryId)
      cq.andWhere('(branch.countryId = :cId OR agent.id IS NULL)', { cId: managerCountryId });
    }

    // Filtros de cliente (NO usamos LIKE aquí para name; filtramos en JS con normIncludes)
    if (filters.countryId) cq.andWhere('country.id = :countryId', { countryId: filters.countryId });
    if (filters.branch)    cq.andWhere('branch.id = :branchId',   { branchId: filters.branch });
    if (filters.agent)     cq.andWhere('agent.id = :agentId',     { agentId: filters.agent });
    if (filters.document)  cq.andWhere('c.document LIKE :doc',    { doc: `%${filters.document}%` });

    if (seenClientIds.size > 0) {
      cq.andWhere('c.id NOT IN (:...ids)', { ids: Array.from(seenClientIds) });
    }

    const clientsNoLoanRaw = await cq.getMany();

    // ✅ Filtro por nombre insensible a tildes/espacios en JS
    const clientsNoLoan = clientsNoLoanRaw.filter(c => normIncludes(c?.name, filters.name));

    for (const client of clientsNoLoan) {
      const agent = client.agent ?? null;
      const fallbackStatus: ClientListStatus = 'inactive';
      if (filters.status && filters.status !== fallbackStatus) continue;
      items.push({
        client,
        agent: agent ? { id: agent.id, name: agent.name } : null,
        loanRequest: null,
        totalRepayment: 0,
        amountBorrowed: 0,
        remainingAmount: 0,
        daysLate: 0,
        status: fallbackStatus,
      });
      if (client.id) seenClientIds.add(client.id);
    }
  }

  // ───────────────────────────────────────────────────────────────
  // 5) Recalcular métricas de mora por CLIENTE (NP, M>15, CR)
  // ───────────────────────────────────────────────────────────────
  mora15 = 0;
  critical20 = 0;
  noPayment30 = 0;
  delinquentClients = 0;

  for (const [, maxLate] of clientMaxDaysLate.entries()) {
    if (maxLate > 0) {
      if (maxLate >= 30) noPayment30++;
      else if (maxLate > 20) critical20++;
      else if (maxLate > 15) mora15++;
    }
  }
  // NP ahora es número de clientes con endDateAt en el mes anterior
  delinquentClients = npClientIds.size;

  // Normalizar daysLate por fila al máximo del cliente,
  // para que los filtros de NP/M15/CR del frontend coincidan
  for (const it of items) {
    const cid = Number(it?.client?.id);
    const maxLate = cid ? clientMaxDaysLate.get(cid) ?? 0 : 0;
    it.daysLate = maxLate;
  }

  // ───────────────────────────────────────────────────────────────
  // 6) Orden + distinct + paginación (igual que tenías)
  // ───────────────────────────────────────────────────────────────
  items.sort((a, b) => {
    const aDate = a.loanRequest?.createdAt ?? a.client?.createdAt ?? new Date(0);
    const bDate = b.loanRequest?.createdAt ?? b.client?.createdAt ?? new Date(0);
    return new Date(bDate).getTime() - new Date(aDate).getTime();
  });

  let listForPaging = items;
  if (filters && (filters as any).distinct === true) {
    const seen = new Set<number>();
    const dedup: any[] = [];
    for (const it of items) {
      const cid = Number(it?.client?.id);
      if (!cid) continue;
      if (!seen.has(cid)) {
        dedup.push(it);
        seen.add(cid);
      }
    }
    listForPaging = dedup;
  }

  const totalItems = listForPaging.length;
  const startIndex = (page - 1) * limit;
  const data = listForPaging.slice(startIndex, startIndex + limit);

  // Si se está aplicando filtro de mora=NP, alinear el contador
  if ((filters as any).mora && String((filters as any).mora).toUpperCase() === 'NP') {
    delinquentClients = totalItems;
  }

  // ───────────────────────────────────────────────────────────────
  // 7) Totales (solo loans activos)
  // ───────────────────────────────────────────────────────────────
  const remainingTotal = items
    .filter((it) => it.loanRequest && isActiveLoan(it.loanRequest))
    .reduce((sum, it) => sum + Number(it.remainingAmount ?? 0), 0);

  return {
    page,
    limit,
    totalItems,
    totalPages: Math.ceil(totalItems / limit),
    totalActiveAmountBorrowed,
    totalActiveRepayment,
    activeClientsCount: activeClientIds.size,
    mora15,
    critical20,
    noPayment30,
    delinquentClients,
    remainingTotal,
    data,
  };
}

async findAll(
  limit: number = 10,
  page: number = 1,
  filters: {
    status?: ClientListStatus;
    mora?: string;
    document?: string;
    name?: string;
    mode?: string;
    type?: string;
    paymentDay?: string;
    agent?: number;
    branch?: number;     // branch del agente (filtro adicional opcional)
    countryId?: number;  // país del cliente (filtro adicional opcional)
    distinct?: boolean;
  } = {},
  requesterUserId: number,
): Promise<any> {
  // ───────────────────────────────────────────────────────────────
  // 0) Scope por rol
  // ───────────────────────────────────────────────────────────────
  const requester = await this.userRepository.findOne({
    where: { id: requesterUserId },
    relations: ['branch', 'managerCountry'],
  });
  if (!requester) throw new BadRequestException('Usuario solicitante no existe.');

  const role = String(requester.role).toUpperCase();
  let adminBranchId: number | null = null;
  let adminBranchCountryId: number | null = null;
  let managerCountryId: number | null = null;

  if (role === 'ADMIN') {
    adminBranchId = (requester as any)?.branch?.id ?? (requester as any)?.branchId ?? null;
    adminBranchCountryId = (requester as any)?.branch?.countryId ?? null;
    if (!adminBranchId) throw new BadRequestException('El ADMIN no tiene branch asignada.');
  } else if (role === 'MANAGER') {
    const raw =
      (requester as any)?.managerCountryId ??
      (requester as any)?.managerCountry?.id ??
      null;

    managerCountryId = raw != null ? Number(raw) : null;
    if (!Number.isFinite(managerCountryId)) {
      throw new BadRequestException('No se pudo determinar managerCountryId para el MANAGER.');
    }
  } else if (role !== 'AGENT') {
    throw new BadRequestException('Rol no soportado. Use AGENT | ADMIN | MANAGER.');
  }

  // ───────────────────────────────────────────────────────────────
  // Helpers para normalizar strings (tildes/espacios)
  // ───────────────────────────────────────────────────────────────
  const norm = (s?: string) =>
    String(s ?? '')
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '') // quita diacríticos
      .replace(/\s+/g, ' ')           // colapsa espacios
      .trim()
      .toLowerCase();

  const normIncludes = (haystack?: string, needle?: string) => {
    const h = norm(haystack);
    const n = norm(needle);
    return n ? h.includes(n) : true;
  };

  // 1) Traer LOANS (con country) — con where SOLO para MANAGER
  // ───────────────────────────────────────────────────────────────
  const findOptions: any = {
    relations: { client: { country: true }, transactions: true, agent: { branch: true } },
    order: { createdAt: 'DESC' },
  };

  if (role === 'MANAGER') {
    // Limita desde BD por país de la branch del agente
    findOptions.where = { agent: { branch: { countryId: managerCountryId } } };
  }

  const loans = await this.loanRequestRepository.find(findOptions);

  // ───────────────────────────────────────────────────────────────
  // 2) Helpers de estado
  // ───────────────────────────────────────────────────────────────
  const lower = (s?: string) => String(s ?? '').toLowerCase();
  const isActiveLoan = (loan: LoanRequest) => this.getLoanListingStatus(loan) === 'active';
  const txTypeOf = (t: any) =>
    lower((t?.type ?? t?.transactionType ?? t?.Transactiontype) as string);
  const now = new Date();
  const daysLateOf = (end?: Date | string | null) => {
    const d = end ? new Date(end) : null;
    return d && now > d ? Math.floor((now.getTime() - d.getTime()) / 86_400_000) : 0;
  };

  // ───────────────────────────────────────────────────────────────
  // 3) Agregadores
  // ───────────────────────────────────────────────────────────────
  let totalActiveAmountBorrowed = 0;
  let totalActiveRepayment = 0;
  const activeClientIds = new Set<number>();
  let mora15 = 0;
  let critical20 = 0;
  let noPayment30 = 0;
  let delinquentClients = 0;
  // Máxima mora por cliente (solo loans activos)
  const clientMaxDaysLate = new Map<number, number>();

  let items: any[] = [];
  const seenClientIds = new Set<number>();

  // ───────────────────────────────────────────────────────────────
  // 4) Iterar LOANS (tu lógica), usando normIncludes para name/doc
  // ───────────────────────────────────────────────────────────────
  for (const loan of loans) {
    const client = loan.client;
    const agent  = loan.agent;
    const branch = agent?.branch as any;
    if (!client || !agent || !branch) continue;

    // Scope
    if (role === 'AGENT') {
      if (agent.id !== requester.id) continue;
    } else if (role === 'ADMIN') {
      if (branch.id !== adminBranchId) continue;
    } else if (role === 'MANAGER') {
      // Verificación defensiva por si alguna relación vino parcial
      const branchCountryId = Number(branch?.countryId ?? branch?.country?.id ?? NaN);
      if (!Number.isFinite(branchCountryId) || branchCountryId !== managerCountryId) continue;
    }

    // Filtros
    if (filters.countryId && (client.country?.id ?? null) !== filters.countryId) continue;
    if (filters.branch && branch.id !== filters.branch) continue;
    if (filters.agent && agent.id !== filters.agent) continue;
    if (filters.document && !normIncludes(client.document, filters.document)) continue;
    if (filters.name && !normIncludes(client.name, filters.name)) continue;

    const derivedStatus = this.getLoanListingStatus(loan);

    if (filters.status && filters.status !== derivedStatus) continue;

    if (filters.mode && String(loan.mode) !== filters.mode) continue;
    if (filters.type && loan.type !== filters.type) continue;
    if (filters.paymentDay && loan.paymentDay !== filters.paymentDay) continue;

    // Métricas
    const amountBorrowed  = Number(loan.amount ?? 0);
    const totalRepayment  = (loan.transactions ?? [])
      .filter((t) => txTypeOf(t) === 'repayment' && t?.amount != null)
      .reduce((s, t) => s + Number(t?.amount ?? 0), 0);
    const remainingAmount = Math.max(0, amountBorrowed - totalRepayment);
    const daysLate        = daysLateOf(loan.endDateAt);

    if (derivedStatus === 'active') {
      totalActiveAmountBorrowed += amountBorrowed;
      totalActiveRepayment     += totalRepayment;
      if (client.id) activeClientIds.add(client.id);

      if (daysLate > 0 && client.id) {
        const prev = clientMaxDaysLate.get(client.id) ?? 0;
        if (daysLate > prev) {
          clientMaxDaysLate.set(client.id, daysLate);
        }
      }
    }

    const lastTransaction = (loan.transactions ?? [])
      .filter(t => txTypeOf(t) === 'repayment' && t?.date)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    items.push({
      client,
      agent: { id: agent.id, name: agent.name },
      loanRequest: {
        id: loan.id,
        status: loan.status,
        amount: loan.amount,
        requestedAmount: loan.requestedAmount,
        createdAt: loan.createdAt,
        updatedAt: loan.updatedAt,
        type: loan.type,
        mode: loan.mode,
        mora: loan.mora,
        endDateAt: loan.endDateAt,
        paymentDay: loan.paymentDay,
        transactions: loan.transactions,
        latestPayment: lastTransaction[0] ?? null,
      },
      totalRepayment,
      amountBorrowed,
      remainingAmount,
      daysLate,
      status: derivedStatus,
    });

    if (client.id) seenClientIds.add(client.id);
  }

  // ───────────────────────────────────────────────────────────────
  // 4.b) CLIENTES SIN LOANS por NAME (se conserva tu lógica actual)
  // ───────────────────────────────────────────────────────────────
  const mustIncludeNoLoanByName = Boolean((filters.name ?? '').trim()) && filters.status !== 'rejected';
  if (mustIncludeNoLoanByName) {
    const cq = this.clientRepository.createQueryBuilder('c')
      .leftJoinAndSelect('c.agent', 'agent')
      .leftJoinAndSelect('agent.branch', 'branch')
      .leftJoinAndSelect('c.country', 'country')
      .leftJoin('c.loanRequests', 'lr')
      .where('lr.id IS NULL'); // sin loans

    // Scope (se mantiene igual que lo tenías)
    if (role === 'AGENT') {
      cq.andWhere('(agent.id = :reqId OR agent.id IS NULL)', { reqId: requester.id });
    } else if (role === 'ADMIN') {
      cq.andWhere('(branch.id = :bId OR agent.id IS NULL)', { bId: adminBranchId });
    } else if (role === 'MANAGER') {
      cq.andWhere('(branch.countryId = :cId OR agent.id IS NULL)', { cId: managerCountryId });
    }

    // Filtros de cliente
    if (filters.countryId) cq.andWhere('country.id = :countryId', { countryId: filters.countryId });
    if (filters.branch)    cq.andWhere('branch.id = :branchId',   { branchId: filters.branch });
    if (filters.agent)     cq.andWhere('agent.id = :agentId',     { agentId: filters.agent });
    if (filters.document)  cq.andWhere('c.document LIKE :doc',    { doc: `%${filters.document}%` });

    if (seenClientIds.size > 0) {
      cq.andWhere('c.id NOT IN (:...ids)', { ids: Array.from(seenClientIds) });
    }

    const clientsNoLoanRaw = await cq.getMany();
    const clientsNoLoan = clientsNoLoanRaw.filter(c => normIncludes(c?.name, filters.name));

    for (const client of clientsNoLoan) {
      const agent = client.agent ?? null;
      items.push({
        client,
        agent: agent ? { id: agent.id, name: agent.name } : null,
        loanRequest: null,
        totalRepayment: 0,
        amountBorrowed: 0,
        remainingAmount: 0,
        daysLate: 0,
        status: 'inactive' as const,
      });
      if (client.id) seenClientIds.add(client.id);
    }
  }

  // ───────────────────────────────────────────────────────────────
  // 5) Recalcular métricas de mora por CLIENTE (NP, M>15, CR)
  // ───────────────────────────────────────────────────────────────
  mora15 = 0;
  critical20 = 0;
  noPayment30 = 0;
  delinquentClients = 0;

  for (const [, maxLate] of clientMaxDaysLate.entries()) {
    if (maxLate > 0) {
      if (maxLate >= 30) noPayment30++;
      else if (maxLate > 20) critical20++;
      else if (maxLate > 15) mora15++;
    }
  }

  // Normalizar daysLate por fila al máximo del cliente,
  // para que los filtros de NP/M15/CR del frontend coincidan
  for (const it of items) {
    const cid = Number(it?.client?.id);
    const maxLate = cid ? clientMaxDaysLate.get(cid) ?? 0 : 0;
    it.daysLate = maxLate;
  }

  // ───────────────────────────────────────────────────────────────
  // 5.b) Filtro de mora (NP, M15, CR) solo para la tabla
  // ───────────────────────────────────────────────────────────────
  if (filters.mora) {
    const code = String(filters.mora).toUpperCase();
    items = items.filter((it) => {
      const dlRaw = (it as any)?.daysLate;
      const dl = Number(dlRaw ?? 0);

      const end = (it as any)?.loanRequest?.endDateAt
        ? new Date((it as any).loanRequest.endDateAt)
        : null;

      if (code === 'NP') {
        if (!end) return false;
        const y = end.getFullYear();
        const m = end.getMonth();
        // NP: préstamos activos con endDateAt en el mes anterior
        const nowLocal = new Date();
        const cm = nowLocal.getMonth();
        const cy = nowLocal.getFullYear();
        const pm = cm === 0 ? 11 : cm - 1;
        const py = cm === 0 ? cy - 1 : cy;
        return y === py && m === pm;
      }

      if (!Number.isFinite(dl) || dl <= 0) return false;
      if (code === 'M15') return dl > 15;
      if (code === 'CR') return dl >= 30;
      return true;
    });
  }

  // ───────────────────────────────────────────────────────────────
  // 6) Orden + distinct + paginación (igual que tenías)
  // ───────────────────────────────────────────────────────────────
  items.sort((a, b) => {
    const aDate = a.loanRequest?.createdAt ?? a.client?.createdAt ?? new Date(0);
    const bDate = b.loanRequest?.createdAt ?? b.client?.createdAt ?? new Date(0);
    return new Date(bDate).getTime() - new Date(aDate).getTime();
  });

  let listForPaging = items;
  if (filters && (filters as any).distinct === true) {
    const seen = new Set<number>();
    const dedup: any[] = [];
    for (const it of items) {
      const cid = Number(it?.client?.id);
      if (!cid) continue;
      if (!seen.has(cid)) {
        dedup.push(it);
        seen.add(cid);
      }
    }
    listForPaging = dedup;
  }

  const totalItems = listForPaging.length;
  const startIndex = (page - 1) * limit;
  const data = listForPaging.slice(startIndex, startIndex + limit);

  // Si se está aplicando filtro de mora=NP, alinear el contador NP con lo listado
  if (filters.mora && String(filters.mora).toUpperCase() === 'NP') {
    delinquentClients = totalItems;
  }

  // ───────────────────────────────────────────────────────────────
  // 7) Totales (solo loans activos)
  // ───────────────────────────────────────────────────────────────
  const remainingTotal = items
    .filter((it) => it.loanRequest && isActiveLoan(it.loanRequest))
    .reduce((sum, it) => sum + Number(it.remainingAmount ?? 0), 0);

  return {
    page,
    limit,
    totalItems,
    totalPages: Math.ceil(totalItems / limit),
    totalActiveAmountBorrowed,
    totalActiveRepayment,
    activeClientsCount: activeClientIds.size,
    mora15,
    critical20,
    noPayment30,
    delinquentClients,
    remainingTotal,
    data,
  };
}

  
  
  // ============================================================
  // ====================  FIND ALL BY AGENT  ===================
  // ============================================================
  async findAllByAgent(
    agentId: number,
    limit: number = 10,
    page: number = 1,
  filters?: {
      status?: ClientListStatus;
      mora?: string;
      document?: string;
      name?: string;
      mode?: string;
      type?: string;
      paymentDay?: string;
    },
  ): Promise<any> {
    const loans = await this.loanRequestRepository.find({
      where: { agent: { id: agentId } },
      relations: { client: true, transactions: true },
      order: { createdAt: 'DESC' },
    });
    
    const clientMap = new Map<number, any[]>();
    for (const loan of loans) {
      const cid = loan.client.id;
      if (!clientMap.has(cid)) clientMap.set(cid, []);
      clientMap.get(cid)!.push(loan);
    }
    
    let allResults: any[] = [];
    let totalActiveAmountBorrowed = 0;
    let totalActiveRepayment = 0;
    let activeClientsCount = 0;
    let mora15 = 0;
    let critical20 = 0;
    let noPayment30 = 0;
    let delinquentClients = 0;
    // Máxima mora por cliente (solo loans activos)
    const clientMaxDaysLate = new Map<number, number>();
    // Clientes NP (endDateAt en el mes anterior)
    const npClientIds = new Set<number>();
    
    for (const [, clientLoans] of clientMap) {
      const client = clientLoans[0].client;
      
      const loanStatuses = clientLoans.map((loan) => this.getLoanListingStatus(loan));
      let status: 'active' | 'inactive' | 'approved' | 'rejected' | 'unknown' = 'unknown';
      if (loanStatuses.includes('active')) status = 'active';
      else if (loanStatuses.includes('approved')) status = 'approved';
      else if (loanStatuses.includes('rejected')) status = 'rejected';
      else status = 'inactive';
      
      if (filters?.status && filters.status !== status) continue;
      if (filters?.document && !client.document?.includes(filters.document))
        continue;
      if (
        filters?.name &&
        !`${client.firstName || ''} ${client.lastName || ''}`
        .toLowerCase()
        .includes(filters.name.toLowerCase())
      )
      continue;
      
      const relevantLoans = clientLoans.filter((loan) => this.getLoanListingStatus(loan) === status);
    
    let clientTotalRepayment = 0;
    let clientAmountBorrowed = 0;
    
    for (const loan of relevantLoans) {
      if (filters?.mode && String(loan.mode) !== filters.mode) continue;
      if (filters?.type && loan.type !== filters.type) continue;
      if (filters?.paymentDay && loan.paymentDay !== filters.paymentDay)
        continue;
      
      const totalRepayment = loan.transactions
      .filter((t) => t.Transactiontype === 'repayment')
      .reduce((s, t) => s + Number(t.amount), 0);
      
      const amountBorrowed = Number(loan.amount);
      const remainingAmount = amountBorrowed - totalRepayment;
      
      const now = new Date();
      const endDate = loan.endDateAt ? new Date(loan.endDateAt) : null;
      const daysLate =
        endDate && now > endDate
          ? Math.floor((now.getTime() - endDate.getTime()) / 86_400_000)
          : 0;
      
      if (status === 'active' && client?.id) {
        if (daysLate > 0) {
          const prev = clientMaxDaysLate.get(client.id) ?? 0;
          if (daysLate > prev) {
            clientMaxDaysLate.set(client.id, daysLate);
          }
        }

        // NP: préstamos activos con endDateAt en el mes anterior
        if (endDate) {
          const currentMonth = now.getMonth();
          const currentYear  = now.getFullYear();
          const prevMonth    = currentMonth === 0 ? 11 : currentMonth - 1;
          const prevYear     = currentMonth === 0 ? currentYear - 1 : currentYear;

          const y = endDate.getFullYear();
          const m = endDate.getMonth();
          if (y === prevYear && m === prevMonth) {
            npClientIds.add(client.id);
          }
        }
      }
      
      allResults.push({
        client, // ← incluye customFields automáticamente
        agent: loan.agent.id,
        loanRequest: {
          id: loan.id,
          status: loan.status,
          amount: loan.amount,
          requestedAmount: loan.requestedAmount,
          createdAt: loan.createdAt,
          updatedAt: loan.updatedAt,
          type: loan.type,
          mode: loan.mode,
          mora: loan.mora,
          endDateAt: loan.endDateAt,
          paymentDay: loan.paymentDay,
          transactions: loan.transactions,
        },
        totalRepayment,
        amountBorrowed,
        remainingAmount,
        daysLate,
        status,
      });
      
      clientTotalRepayment += totalRepayment;
      clientAmountBorrowed += amountBorrowed;
    }
    
      if (status === 'active') {
        totalActiveAmountBorrowed += clientAmountBorrowed;
        totalActiveRepayment += clientTotalRepayment;
        activeClientsCount++;
      }
  }

  // Recalcular métricas de mora por CLIENTE (NP, M>15, CR)
  mora15 = 0;
  critical20 = 0;
  noPayment30 = 0;
  delinquentClients = 0;

  for (const [, maxLate] of clientMaxDaysLate.entries()) {
    if (maxLate > 0) {
      if (maxLate >= 30) noPayment30++;
      else if (maxLate > 20) critical20++;
      else if (maxLate > 15) mora15++;
    }
  }

  // NP: clientes con endDateAt en el mes anterior
  delinquentClients = npClientIds.size;

  // Normalizar daysLate por fila al máximo del cliente
  for (const it of allResults) {
    const cid = Number(it?.client?.id);
    const maxLate = cid ? clientMaxDaysLate.get(cid) ?? 0 : 0;
    it.daysLate = maxLate;
  }

  // Filtro de mora para la tabla en findAllByAgent
  if (filters?.mora) {
    const code = String(filters.mora).toUpperCase();
    allResults = allResults.filter((it) => {
      const dlRaw = (it as any)?.daysLate;
      const dl = Number(dlRaw ?? 0);
      const end = (it as any)?.loanRequest?.endDateAt
        ? new Date((it as any).loanRequest.endDateAt)
        : null;

      if (code === 'NP') {
        if (!end) return false;
        const now = new Date();
        const currentMonth = now.getMonth();
        const currentYear  = now.getFullYear();
        const prevMonth    = currentMonth === 0 ? 11 : currentMonth - 1;
        const prevYear     = currentMonth === 0 ? currentYear - 1 : currentYear;
        const y = end.getFullYear();
        const m = end.getMonth();
        return y === prevYear && m === prevMonth;
      }

      if (!Number.isFinite(dl) || dl <= 0) return false;
      if (code === 'M15') return dl > 15;
      if (code === 'CR') return dl >= 30;
      return true;
    });
  }
  
  const totalItems = allResults.length;
  const startIndex = (page - 1) * limit;
  const paginated = allResults.slice(startIndex, startIndex + limit);

  // Si se aplica filtro mora=NP, usar el total filtrado como NP
  if (filters?.mora && String(filters.mora).toUpperCase() === 'NP') {
    delinquentClients = totalItems;
  }
  
  const totalSaldoClientes = totalActiveAmountBorrowed - totalActiveRepayment;
  
  return {
    page,
    limit,
    totalItems,
    totalPages: Math.ceil(totalItems / limit),
    totalActiveAmountBorrowed,
    totalActiveRepayment,
    totalSaldoClientes,
    activeClientsCount,
    mora15,
    critical20,
    noPayment30,
    delinquentClients,
    data: paginated,
  };
}

// ============================================================
// ========================= FIND ONE =========================
// ============================================================
async findOne(id: number): Promise<any | null> {
  const result = await this.clientRepository
  .createQueryBuilder('client')
  .innerJoin('client.loanRequests', 'loan', 'loan.status IN (:...status)', {
    status: ['funded', 'renewed'],
  })
  .innerJoin('loan.transactions', 'txn')
  .where('client.id = :id', { id })
  .select('client.id', 'clientId')
  .addSelect('client.name', 'clientName')
  .addSelect('loan.id', 'loanRequestId')
  .addSelect('loan.mode', 'loanMode')
  .addSelect('loan.type', 'loanType')
  .addSelect('loan.amount', 'totalAmountToPay')
  .addSelect(
    `
      CASE 
        WHEN loan.endDateAt IS NOT NULL AND loan.endDateAt < CURRENT_DATE()
        THEN DATEDIFF(CURRENT_DATE(), loan.endDateAt)
        ELSE 0
      END
      `,
    'diasMora',
  )
  .addSelect(
    `SUM(CASE WHEN txn.Transactiontype = 'disbursement' THEN txn.amount ELSE 0 END)`,
    'montoPrestado',
  )
  .addSelect(
    `SUM(CASE WHEN txn.Transactiontype = 'repayment' THEN txn.amount ELSE 0 END)`,
    'totalPagado',
  )
  .addSelect(
    `loan.amount - SUM(CASE WHEN txn.Transactiontype = 'repayment' THEN txn.amount ELSE 0 END)`,
    'pendientePorPagar',
  )
  .groupBy('client.id')
  .addGroupBy('loan.id')
  .getRawOne();
  
  // Trae TODO el cliente con TODAS sus loanRequests (sin filtrar)
  const fullClient = await this.clientRepository.findOne({
    where: { id },
    relations: { loanRequests: { transactions: true } },
  });
  
  // --- Derivar estado del cliente (sin tocar el de BD si no quieres) ---
  let derivedClientStatus: 'ACTIVE' | 'INACTIVE' | 'REJECTED' | 'PROSPECT' | undefined;
  
  if (fullClient) {
    const allLoans = fullClient.loanRequests ?? [];
    derivedClientStatus = this.getClientListingStatus(allLoans);
    
    // Mantén visibilidad sólo de loans no completados/rechazados si se requiere
    fullClient.loanRequests = allLoans.filter(
      (loan) => loan.status !== 'completed' && loan.status !== 'rejected',
    );
  }

  console.log("fullClient", fullClient);
  
  
  const clientResponse = fullClient
  ? {
    id: fullClient.id,
    name: fullClient.name,
    phone: fullClient.phone,
    phone2: (fullClient as any).phone2 ?? null,
    email: fullClient.email,
    city: fullClient.city,
    document: fullClient.document,
    documentType: fullClient.documentType,
    address: fullClient.address,
    address2: (fullClient as any).address2 ?? null,
    referenceName: (fullClient as any).referenceName ?? null,
    referencePhone: (fullClient as any).referencePhone ?? null,
    referenceRelationship: (fullClient as any).referenceRelationship ?? null,
    
    // ⬇️ usa el derivado, no el de BD (o sincronízalo si quieres)
    status: derivedClientStatus,
    
    totalLoanAmount: fullClient.totalLoanAmount,
    notEligible: fullClient.notEligible,
    lead: fullClient.lead,
    customFields: Array.isArray((fullClient as any).customFields)
    ? (fullClient as any).customFields
    : [],
    loanRequests: fullClient.loanRequests,
  }
  : null;
  
  return {
    ...result,
    client: clientResponse,
  };
}


// ============================================================
// ===============  ENVÍO DE ONBOARDING WHATSAPP ==============
// ============================================================
private toMsisdnDigits(phone: string, fallbackCc = '57'): string {
  const raw = String(phone || '').trim();
  if (!raw) return '';
  if (raw.startsWith('+') || raw.startsWith('00')) {
    return raw.replace(/\D/g, '');
  }
  // Si ya viene con 57 o 506, asumimos que incluye indicativo
  if (/^(57|506)\d{6,}$/.test(raw.replace(/\D/g, ''))) {
    return raw.replace(/\D/g, '');
  }
  return `${fallbackCc}${raw.replace(/\D/g, '')}`;
}

private async sendOnboardingIfConfigured(client: Client): Promise<void> {
  try {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId =
    process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_SENDER_ID;
    const template = process.env.WHATSAPP_ONBOARDING_TEMPLATE;
    
    if (!token || !phoneId || !template) {
      return;
    }
    
    const to = this.toMsisdnDigits(client.phone || '');
    if (!to) {
      return;
    }
    
    const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
    
    const body = {
      messaging_product: 'whatsapp',
      to, // MSISDN sin '+'
      type: 'template',
      template: {
        name: template,
        language: { code: 'es' },
      },
    };
    
    // Node 18+ tiene fetch; si no, sustituir por axios
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(
        `[ClientsService] WhatsApp onboarding failed: ${res.status} ${res.statusText} - ${text}`,
      );
    }
  } catch (err) {
    console.warn(
      '[ClientsService] WhatsApp onboarding error:',
      (err as any)?.message || err,
    );
  }
}

// ============================================================
// =========================  CREATE  =========================
// ============================================================
async create(data: Partial<Client>): Promise<Client> {
  // 1) Validación de duplicados por document/email (tu lógica)
  if (data.document || data.email) {
    const dup = await this.clientRepository.findOne({
      where: [
        data.document ? { document: data.document } : ({} as any),
        data.email ? { email: data.email } : ({} as any),
      ],
    });
    if (dup) {
      throw new ConflictException(
        'A client with the same document or email already exists',
      );
    }
  }

  // 2) Resolver countryId desde el payload (countryId o country.id)
  const rawCountryId =
    (data as any)?.countryId ??
    (data as any)?.country?.id ??
    null;

  const countryIdNum = Number(rawCountryId);
  if (!rawCountryId || !Number.isFinite(countryIdNum)) {
    throw new BadRequestException('countryId es obligatorio y debe ser numérico para crear un cliente.');
  }

  // 3) Verificar que el país exista
  const country = await this.countryRepository.findOne({ where: { id: countryIdNum } });
  if (!country) {
    throw new BadRequestException('El país indicado no existe.');
  }

  // 4) Normalizar customFields
  const customFields = this.normalizeCustomFields((data as any)?.customFields);

  // 5) Armar payload "sanitizado"
  const sanitized: Partial<Client> = {
    ...data,
    country,        // ← asignar la relación; NO existe client.countryId
    customFields,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // limpiar claves que no deben llegar
  delete (sanitized as any).countryId;
  delete (sanitized as any).branch;
  delete (sanitized as any).branchId;

  // 6) Persistir
  const client = this.clientRepository.create(sanitized);
  const saved = await this.clientRepository.save(client);

  // 7) (Opcional) WhatsApp onboarding
  // this.sendOnboardingIfConfigured(saved).catch(() => {});

  return saved;
}


}
