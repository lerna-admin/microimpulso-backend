import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Client } from '../entities/client.entity';
import { LoanRequest, LoanRequestStatus } from 'src/entities/loan-request.entity';
import { ChatMessage } from 'src/entities/chat-message.entity';
import { User } from 'src/entities/user.entity';
import { Country } from 'src/entities/country.entity';

type ClientListStatus = 'active' | 'inactive' | 'approved' | 'rejected' | 'under_review' | 'lead';

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
    const amount = Number(loan?.requestedAmount ?? loan?.amount ?? 0);
    return Number.isFinite(amount) && amount > 1;
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
    if (normalized === LoanRequestStatus.UNDER_REVIEW) {
      return 'under_review';
    }
    if (normalized === LoanRequestStatus.NEW || normalized === 'prospect') {
      return 'lead';
    }
    if (this.ACTIVE_LOAN_STATUSES.has(normalized) && this.loanHasServiceAmount(loan)) {
      return 'active';
    }
    if (normalized === LoanRequestStatus.COMPLETED) {
      return 'inactive';
    }
    if (normalized === LoanRequestStatus.CANCELED) {
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

  private computeDaysLateValue(loan: LoanRequest): number {
    if (!loan?.endDateAt) return 0;
    const dueDate = new Date(loan.endDateAt);
    const now = new Date();
    return now > dueDate ? Math.floor((now.getTime() - dueDate.getTime()) / 86_400_000) : 0;
  }

  private buildMaxDaysLateMap(
    loans: LoanRequest[],
    predicate: (loan: LoanRequest) => boolean,
  ): Map<number, number> {
    const maxLateByClient = new Map<number, number>();
    for (const loan of loans ?? []) {
      if (!loan) continue;
      if (!predicate(loan)) continue;
      if (this.getLoanListingStatus(loan) !== 'active') continue;
      if (!this.loanHasServiceAmount(loan)) continue;
      const clientId = loan.client?.id;
      if (!clientId) continue;
      const daysLate = this.computeDaysLateValue(loan);
      if (daysLate <= 0) continue;
      const prev = maxLateByClient.get(clientId) ?? 0;
      if (daysLate > prev) {
        maxLateByClient.set(clientId, daysLate);
      }
    }
    return maxLateByClient;
  }

  private countClientsByLateThreshold(
    maxLateByClient: Map<number, number>,
    threshold: number,
    inclusive = false,
  ): number {
    let total = 0;
    for (const late of maxLateByClient.values()) {
      const meets = inclusive ? late >= threshold : late > threshold;
      if (meets) total++;
    }
    return total;
  }

  // CR → clientes con al menos 1 día de mora.
  private countClientsWithCriticalDelay(maxLateByClient: Map<number, number>): number {
    return this.countClientsByLateThreshold(maxLateByClient, 1, true);
  }

  // M>15 → clientes con más de 15 días de mora.
  private countClientsWithMora15Delay(maxLateByClient: Map<number, number>): number {
    return this.countClientsByLateThreshold(maxLateByClient, 15, false);
  }

  // NP → clientes con más de 30 días sin pago.
  private countClientsWithNoPayment30Delay(maxLateByClient: Map<number, number>): number {
    return this.countClientsByLateThreshold(maxLateByClient, 30, false);
  }

  private computeMoraStatsFromLoans(
    loans: LoanRequest[],
    predicate: (loan: LoanRequest) => boolean,
  ): { ge1: number; gt15: number; gt30: number } {
    const maxLateByClient = this.buildMaxDaysLateMap(loans, predicate);
    return {
      ge1: this.countClientsWithCriticalDelay(maxLateByClient),
      gt15: this.countClientsWithMora15Delay(maxLateByClient),
      gt30: this.countClientsWithNoPayment30Delay(maxLateByClient),
    };
  }

  /**
   * Calcula métricas agregadas de préstamos ACTIVOS (funded/renewed con monto > 1)
   * respetando el scope del usuario (AGENT, ADMIN, MANAGER) y filtros básicos
   * (branch, agent, countryId).
   *
   * Esta ruta se usa principalmente para el bloque de estadísticas en la vista
   * de clientes (statsResponse en el frontend).
   */
  private async computeActiveStatsForScope(
    requester: User,
    role: string,
    adminBranchId: number | null,
    managerCountryId: number | null,
    filters: {
      branch?: number;
      agent?: number;
      countryId?: number;
    } = {},
  ): Promise<{
    totalActiveAmountBorrowed: number;
    totalActiveRepayment: number;
    remainingTotal: number;
    activeClientsCount: number;
    mora15: number;
    critical20: number;
    noPayment30: number;
    delinquentClients: number;
  }> {
    const whereParts: string[] = [];
    const values: any[] = [];

    // Solo préstamos activos con monto de servicio
    whereParts.push(
      `(loan.status IN ('funded','renewed') AND COALESCE(loan.requestedAmount, loan.amount, 0) > 1)`,
    );

    // Scope por rol
    if (role === 'AGENT') {
      whereParts.push(`loan.agentId = ?`);
      values.push(requester.id);
    } else if (role === 'ADMIN') {
      if (!adminBranchId) {
        throw new BadRequestException('El ADMIN no tiene branch asignada.');
      }
      whereParts.push(`agent.branchId = ?`);
      values.push(adminBranchId);
    } else if (role === 'MANAGER') {
      if (!Number.isFinite(managerCountryId)) {
        throw new BadRequestException('No se pudo determinar managerCountryId para el MANAGER.');
      }
      whereParts.push(`branch.countryId = ?`);
      values.push(managerCountryId);
    }

    // Filtros adicionales
    if (filters.branch) {
      whereParts.push(`branch.id = ?`);
      values.push(filters.branch);
    }
    if (filters.agent) {
      whereParts.push(`agent.id = ?`);
      values.push(filters.agent);
    }
    if (filters.countryId) {
      whereParts.push(`client.countryId = ?`);
      values.push(filters.countryId);
    }

    const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    // Totales de monto prestado, repagos y clientes activos
    const totalsSql = `
      SELECT
        COALESCE(SUM(loan.amount), 0) AS totalActiveAmountBorrowed,
        COALESCE(SUM(CASE WHEN txn.Transactiontype = 'repayment' THEN txn.amount ELSE 0 END), 0) AS totalActiveRepayment,
        COUNT(DISTINCT loan.clientId) AS activeClientsCount
      FROM loan_request loan
      INNER JOIN user   agent  ON agent.id = loan.agentId
      INNER JOIN branch branch ON branch.id = agent.branchId
      INNER JOIN client client ON client.id = loan.clientId
      LEFT JOIN loan_transaction txn ON txn.loanRequestId = loan.id
      ${whereSql};
    `;

    // Mora por cliente (máx días de atraso)
    const moraSql = `
      SELECT
        loan.clientId     AS clientId,
        MAX(GREATEST(DATEDIFF(CURDATE(), loan.endDateAt), 0)) AS maxLate
      FROM loan_request loan
      INNER JOIN user   agent  ON agent.id = loan.agentId
      INNER JOIN branch branch ON branch.id = agent.branchId
      INNER JOIN client client ON client.id = loan.clientId
      ${whereSql}
        AND loan.endDateAt IS NOT NULL
      GROUP BY loan.clientId;
    `;

    const [totalsRows, moraRows] = await Promise.all([
      this.loanRequestRepository.query(totalsSql, values),
      this.loanRequestRepository.query(moraSql, values),
    ]);

    const totals = totalsRows[0] ?? {};

    const totalActiveAmountBorrowed = Number(totals.totalActiveAmountBorrowed ?? 0);
    const totalActiveRepayment = Number(totals.totalActiveRepayment ?? 0);
    const activeClientsCount = Number(totals.activeClientsCount ?? 0);
    const remainingTotal = totalActiveAmountBorrowed - totalActiveRepayment;

    let ge1 = 0;
    let gt15 = 0;
    let gt20 = 0;
    let gt30 = 0;
    for (const row of moraRows) {
      const maxLate = Number(row.maxLate ?? 0);
      if (!Number.isFinite(maxLate)) continue;
      if (maxLate >= 1) ge1++;
      if (maxLate > 15) gt15++;
      if (maxLate > 20) gt20++;
      if (maxLate > 30) gt30++;
    }

    const noPayment30 = ge1;          // CR (>=1 día) — se mantiene el nombre existente
    const mora15 = gt15;              // M>15
    const critical20 = gt20;          // >20 días
    const delinquentClients = gt30;   // NP (>30)

    return {
      totalActiveAmountBorrowed,
      totalActiveRepayment,
      remainingTotal,
      activeClientsCount,
      mora15,
      critical20,
      noPayment30,
      delinquentClients,
    };
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
    relations: ['agent', 'country'],
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
    const newCountry = await this.countryRepository.findOne({ where: { id: newCountryId } });
    if (!newCountry) throw new BadRequestException('El país indicado no existe.');
    client.country = newCountry;

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

  if ('phone' in data || 'countryId' in data || 'country' in data) {
    const normalizedPhone = this.normalizePhoneForCountry(client.phone, client.country ?? null);
    if (normalizedPhone) {
      client.phone = normalizedPhone;
    }
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

  const chatStatsMap = await this.buildChatStatsMap();
  const clientHasChats = (clientId?: number | null): boolean => {
    if (!clientId) return false;
    const stats = chatStatsMap.get(clientId);
    return (stats?.total ?? 0) > 0;
  };

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

  const toUtcMidday = (value?: Date | string | null): Date | null => {
    if (!value) return null;
    const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0, 0));
  };

  // ───────────────────────────────────────────────────────────────
  // 1) Traer LOANS (con country) para filtrar como hacías
  // ───────────────────────────────────────────────────────────────
  const loans = await this.loanRequestRepository.find({
    relations: { client: { country: true }, transactions: true, agent: { branch: true } },
    order: { createdAt: 'DESC' },
  });

  const canSeeLoan = (loan: LoanRequest): boolean => {
    const agent = loan.agent;
    const branch = agent?.branch as any;
    if (!agent || !branch) return false;

    if (role === 'AGENT') {
      return agent.id === requester.id;
    }
    if (role === 'ADMIN') {
      return branch.id === adminBranchId;
    }
    if (role === 'MANAGER') {
      const branchCountryId = Number(branch?.countryId ?? branch?.country?.id ?? NaN);
      return Number.isFinite(branchCountryId) && branchCountryId === managerCountryId;
    }
    return false;
  };

  // ───────────────────────────────────────────────────────────────
  // 2) Helpers de estado
  // ───────────────────────────────────────────────────────────────
  const lower = (s?: string) => String(s ?? '').toLowerCase();
  const isActiveLoan = (loan: LoanRequest) => {
    const status = this.getLoanListingStatus(loan);
    const amount = Number(loan.amount ?? loan.requestedAmount ?? 0);
    return status === 'active' && Number.isFinite(amount) && amount > 0;
  };
  const txTypeOf = (t: any) =>
    lower((t?.type ?? t?.transactionType ?? t?.Transactiontype) as string);
  const now = new Date();
  const daysLateOf = (end?: Date | string | null) => {
    const d = end ? new Date(end) : null;
    return d && now > d ? Math.floor((now.getTime() - d.getTime()) / 86_400_000) : 0;
  };
  const computeDaysLate = (loan: LoanRequest): number => daysLateOf(loan.endDateAt);

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
  const clientMaxDaysLate = new Map<number, number>();

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

    const derivedStatus: ClientListStatus = this.getLoanListingStatus(loan);
    const datedTransactions = (loan.transactions ?? [])
      .filter((t) => t?.date)
      .sort((a, b) => new Date(a.date as any).getTime() - new Date(b.date as any).getTime());
    const firstTransactionDate = datedTransactions.length > 0 ? datedTransactions[0].date : null;
    const normalizedStartDate = toUtcMidday(firstTransactionDate ?? loan.createdAt) ?? loan.createdAt;
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

    }

    if (filters.document && !normIncludes(client.document, filters.document)) continue;
    if (filters.name && !normIncludes(client.name, filters.name)) continue;
    if (filters.status && filters.status !== derivedStatus) continue;
    if (filters.mode && String(loan.mode) !== filters.mode) continue;
    if (filters.type && loan.type !== filters.type) continue;
    if (filters.paymentDay && loan.paymentDay !== filters.paymentDay) continue;

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
        createdAt: normalizedStartDate,
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
      diasMora: derivedStatus === 'active' ? daysLate : 0,
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

  // Normalizar daysLate por fila al máximo del cliente,
  // para que los filtros de NP/M15/CR del frontend coincidan
  for (const it of items) {
    const cid = Number(it?.client?.id);
    const maxLate = cid ? clientMaxDaysLate.get(cid) ?? 0 : 0;
    const lateValue = (it as any)?.status === 'active' ? maxLate : 0;
    if (it?.loanRequest) {
      const normalizedCreatedAt = toUtcMidday(it.loanRequest.createdAt) ?? it.loanRequest.createdAt;
      if (normalizedCreatedAt) {
        it.loanRequest.createdAt = normalizedCreatedAt;
      }
    }
    it.daysLate = lateValue;
    (it as any).diasMora = lateValue;
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

async findAllLegacy(
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

  const toUtcMidday = (value?: Date | string | null): Date | null => {
    if (!value) return null;
    const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0, 0));
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

  const matchesScopeForLoan = (loan: LoanRequest): boolean => {
    const client = loan.client;
    const agent = loan.agent;
    const branch = agent?.branch as any;
    if (!client || !agent || !branch) return false;

    if (role === 'AGENT') {
      if (agent.id !== requester.id) return false;
    } else if (role === 'ADMIN') {
      if (branch.id !== adminBranchId) return false;
    } else if (role === 'MANAGER') {
      const branchCountryId = Number(branch?.countryId ?? branch?.country?.id ?? NaN);
      if (!Number.isFinite(branchCountryId) || branchCountryId !== managerCountryId) return false;
    }

    if (filters.countryId && (client.country?.id ?? null) !== filters.countryId) return false;
    if (filters.branch && branch.id !== filters.branch) return false;
    if (filters.agent && agent.id !== filters.agent) return false;

    return true;
  };

  const scopedLoans = loans.filter(matchesScopeForLoan);

  // Máxima mora por cliente (solo loans activos dentro del scope)
  const clientMaxDaysLate = this.buildMaxDaysLateMap(scopedLoans, () => true);
  const noPayment30 = this.countClientsWithCriticalDelay(clientMaxDaysLate);        // CR (>=1 día)
  const mora15 = this.countClientsWithMora15Delay(clientMaxDaysLate);               // M>15
  const delinquentClients = this.countClientsWithNoPayment30Delay(clientMaxDaysLate); // NP (>30)
  const critical20 = this.countClientsByLateThreshold(clientMaxDaysLate, 20, false);

  let items: any[] = [];
  const seenClientIds = new Set<number>();

  // ───────────────────────────────────────────────────────────────
  // 4) Iterar LOANS (tu lógica), usando normIncludes para name/doc
  // ───────────────────────────────────────────────────────────────
  for (const loan of scopedLoans) {
    const client = loan.client;
    const agent  = loan.agent;
    const branch = agent?.branch as any;
    if (!client || !agent || !branch) continue;
    if (filters.document && !normIncludes(client.document, filters.document)) continue;
    if (filters.name && !normIncludes(client.name, filters.name)) continue;

    const derivedStatus = this.getLoanListingStatus(loan);
    const datedTransactions = (loan.transactions ?? [])
      .filter((t) => t?.date)
      .sort((a, b) => new Date(a.date as any).getTime() - new Date(b.date as any).getTime());
    const firstTransactionDate = datedTransactions.length > 0 ? datedTransactions[0].date : null;
    const normalizedStartDate = toUtcMidday(firstTransactionDate ?? loan.createdAt) ?? loan.createdAt;

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
        createdAt: normalizedStartDate,
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
        diasMora: 0,
        status: 'inactive' as const,
      });
      if (client.id) seenClientIds.add(client.id);
    }
  }

  // ───────────────────────────────────────────────────────────────
  // 5) Normalizar daysLate por fila al máximo del cliente,
  // para que los filtros de NP/M15/CR del frontend coincidan
  for (const it of items) {
    const cid = Number(it?.client?.id);
    const maxLate = cid ? clientMaxDaysLate.get(cid) ?? 0 : 0;
    if (it?.loanRequest) {
      const normalizedCreatedAt = toUtcMidday(it.loanRequest.createdAt) ?? it.loanRequest.createdAt;
      if (normalizedCreatedAt) {
        it.loanRequest.createdAt = normalizedCreatedAt;
      }
    }
    it.daysLate = maxLate;
  }

  // ───────────────────────────────────────────────────────────────
  // 5.b) Filtro de mora (NP, M15, CR) solo para la tabla
  // ───────────────────────────────────────────────────────────────
  if (filters.mora) {
    const code = String(filters.mora).toUpperCase();
    items = items.filter((it) => {
      if ((it as any)?.status !== 'active') return false;
      const dl = Number((it as any)?.daysLate ?? 0);
      if (!Number.isFinite(dl)) return false;
      if (code === 'NP') return dl > 30;
      if (code === 'M15') return dl > 15;
      if (code === 'CR') return dl >= 1;
      return false;
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
// ====================  FIND ALL (OPTIMIZED)  ==================
// ============================================================
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
  let managerCountryId: number | null = null;

  if (role === 'ADMIN') {
    adminBranchId = (requester as any)?.branch?.id ?? (requester as any)?.branchId ?? null;
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

  const limitSafe = Math.max(1, Math.min(limit ?? 10, 100));
  const pageSafe = Math.max(1, page ?? 1);

  // ───────────────────────────────────────────────────────────────
  // 1) Modo estadísticas (distinct=true y sin filtro por nombre)
  // ───────────────────────────────────────────────────────────────
  const isStatsMode = Boolean(filters?.distinct) && !filters?.name;
  if (isStatsMode) {
    const stats = await this.computeActiveStatsForScope(
      requester,
      role,
      adminBranchId,
      managerCountryId,
      {
        branch: filters.branch,
        agent: filters.agent,
        countryId: filters.countryId,
      },
    );

    return {
      page: pageSafe,
      limit: limitSafe,
      totalItems: 0,
      totalPages: 0,
      data: [],
      ...stats,
    };
  }

  // ───────────────────────────────────────────────────────────────
  // 2) Listado paginado de loans (para tabla de clientes)
  // ───────────────────────────────────────────────────────────────
  const qb = this.loanRequestRepository.createQueryBuilder('loan')
    .leftJoin('loan.client', 'client')
    .leftJoin('loan.agent', 'agent')
    .leftJoin('agent.branch', 'branch')
    .leftJoin('client.country', 'country');

  // Scope por rol
  if (role === 'AGENT') {
    qb.andWhere('agent.id = :reqAgentId', { reqAgentId: requester.id });
  } else if (role === 'ADMIN' && adminBranchId) {
    qb.andWhere('branch.id = :reqBranchId', { reqBranchId: adminBranchId });
  } else if (role === 'MANAGER' && Number.isFinite(managerCountryId)) {
    qb.andWhere('branch.countryId = :reqCountryId', { reqCountryId: managerCountryId });
  }

  // Filtros por país / branch / agente
  if (filters.countryId) {
    qb.andWhere('client.countryId = :filterCountryId', { filterCountryId: filters.countryId });
  }
  if (filters.branch) {
    qb.andWhere('branch.id = :filterBranchId', { filterBranchId: filters.branch });
  }
  if (filters.agent) {
    qb.andWhere('agent.id = :filterAgentId', { filterAgentId: filters.agent });
  }

  // Filtros por status lógico (lead/active/etc.)
  if (filters.status) {
    const s = String(filters.status).toLowerCase() as ClientListStatus;
    if (s === 'rejected') {
      qb.andWhere('LOWER(loan.status) = :stRejected', { stRejected: LoanRequestStatus.REJECTED });
    } else if (s === 'approved') {
      qb.andWhere('LOWER(loan.status) = :stApproved', { stApproved: LoanRequestStatus.APPROVED });
    } else if (s === 'under_review') {
      qb.andWhere('LOWER(loan.status) = :stReview', { stReview: LoanRequestStatus.UNDER_REVIEW });
    } else if (s === 'lead') {
      qb.andWhere(
        `(LOWER(loan.status) = :stNew OR LOWER(loan.status) = :stProspect)`,
        { stNew: LoanRequestStatus.NEW, stProspect: 'prospect' },
      );
    } else if (s === 'active') {
      qb.andWhere(
        `LOWER(loan.status) IN (:...stActive) AND COALESCE(loan.requestedAmount, loan.amount, 0) > 1`,
        { stActive: [LoanRequestStatus.FUNDED, LoanRequestStatus.RENEWED] },
      );
    } else if (s === 'inactive') {
      qb.andWhere(
        `LOWER(loan.status) IN (:...stInactive)`,
        { stInactive: [LoanRequestStatus.COMPLETED, LoanRequestStatus.CANCELED] },
      );
    }
  }

  // Filtros adicionales
  if (filters.mode) {
    qb.andWhere('loan.mode = :filterMode', { filterMode: filters.mode });
  }
  if (filters.type) {
    qb.andWhere('loan.type = :filterType', { filterType: filters.type });
  }
  if (filters.paymentDay) {
    qb.andWhere('loan.paymentDay = :filterPaymentDay', { filterPaymentDay: filters.paymentDay });
  }
  if (filters.document) {
    qb.andWhere('client.document LIKE :filterDoc', { filterDoc: `%${filters.document}%` });
  }
  if (filters.name) {
    qb.andWhere('client.name LIKE :filterName', { filterName: `%${filters.name}%` });
  }

  // Conteo total (para paginación)
  const totalItems = await qb.clone().getCount();
  if (totalItems === 0) {
    return {
      page: pageSafe,
      limit: limitSafe,
      totalItems: 0,
      totalPages: 0,
      totalActiveAmountBorrowed: 0,
      totalActiveRepayment: 0,
      totalSaldoClientes: 0,
      activeClientsCount: 0,
      mora15: 0,
      critical20: 0,
      noPayment30: 0,
      delinquentClients: 0,
      data: [],
    };
  }

  // Obtener IDs de loans para la página solicitada
  const idsRows = await qb
    .clone()
    .select('loan.id', 'id')
    .orderBy('loan.createdAt', 'DESC')
    .skip((pageSafe - 1) * limitSafe)
    .take(limitSafe)
    .getRawMany<{ id: number }>();

  const loanIds = idsRows.map((r) => Number(r.id)).filter((v) => Number.isFinite(v));

  if (!loanIds.length) {
    return {
      page: pageSafe,
      limit: limitSafe,
      totalItems,
      totalPages: Math.ceil(totalItems / limitSafe),
      totalActiveAmountBorrowed: 0,
      totalActiveRepayment: 0,
      totalSaldoClientes: 0,
      activeClientsCount: 0,
      mora15: 0,
      critical20: 0,
      noPayment30: 0,
      delinquentClients: 0,
      data: [],
    };
  }

  // Cargar loans completos SOLO para la página (incluye transacciones)
  const loansPage = await this.loanRequestRepository.find({
    where: { id: In(loanIds) },
    relations: { client: { country: true }, transactions: true, agent: { branch: true } },
  });

  // Mantener el orden de loanIds
  const loansMap = new Map<number, LoanRequest>();
  for (const loan of loansPage) {
    loansMap.set(loan.id, loan);
  }
  const orderedLoans: LoanRequest[] = loanIds
    .map((id) => loansMap.get(id))
    .filter((l): l is LoanRequest => !!l);

  const toUtcMidday = (value?: Date | string | null): Date | null => {
    if (!value) return null;
    const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0, 0));
  };

  const lower = (s?: string) => String(s ?? '').toLowerCase();
  const txTypeOf = (t: any) =>
    lower((t?.type ?? t?.transactionType ?? t?.Transactiontype) as string);

  const now = new Date();
  const daysLateOf = (end?: Date | string | null) => {
    const d = end ? new Date(end) : null;
    return d && now > d ? Math.floor((now.getTime() - d.getTime()) / 86_400_000) : 0;
  };

  const rows: any[] = [];
  let totalActiveAmountBorrowed = 0;
  let totalActiveRepayment = 0;
  let activeClientsCount = 0;
  const activeClientIds = new Set<number>();

  for (const loan of orderedLoans) {
    const client = loan.client;
    const agent = loan.agent;
    if (!client || !agent) continue;

    const datedTransactions = (loan.transactions ?? [])
      .filter((t) => t?.date)
      .sort((a, b) => new Date(a.date as any).getTime() - new Date(b.date as any).getTime());
    const firstTransactionDate = datedTransactions.length > 0 ? datedTransactions[0].date : null;
    const normalizedStartDate = toUtcMidday(firstTransactionDate ?? loan.createdAt) ?? loan.createdAt;

    const amountBorrowed = Number(loan.amount ?? 0);
    const totalRepayment = (loan.transactions ?? [])
      .filter((t) => txTypeOf(t) === 'repayment' && t?.amount != null)
      .reduce((s, t) => s + Number(t?.amount ?? 0), 0);
    const remainingAmount = Math.max(0, amountBorrowed - totalRepayment);
    const daysLate = daysLateOf(loan.endDateAt);

    const listingStatus = this.getLoanListingStatus(loan);

    if (listingStatus === 'active') {
      totalActiveAmountBorrowed += amountBorrowed;
      totalActiveRepayment += totalRepayment;
      if (client.id) activeClientIds.add(client.id);
    }

    const lastTransaction = (loan.transactions ?? [])
      .filter((t) => txTypeOf(t) === 'repayment' && t?.date)
      .sort((a, b) => new Date(b.date as any).getTime() - new Date(a.date as any).getTime());

    rows.push({
      client,
      agent: { id: agent.id, name: agent.name },
      loanRequest: {
        id: loan.id,
        status: loan.status,
        amount: loan.amount,
        requestedAmount: loan.requestedAmount,
        createdAt: normalizedStartDate,
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
      diasMora: listingStatus === 'active' ? daysLate : 0,
      status: listingStatus,
    });
  }

  activeClientsCount = activeClientIds.size;
  const totalPages = Math.ceil(totalItems / limitSafe);
  const totalSaldoClientes = totalActiveAmountBorrowed - totalActiveRepayment;

  return {
    page: pageSafe,
    limit: limitSafe,
    totalItems,
    totalPages,
    totalActiveAmountBorrowed,
    totalActiveRepayment,
    totalSaldoClientes,
    activeClientsCount,
    mora15: 0,
    critical20: 0,
    noPayment30: 0,
    delinquentClients: 0,
    data: rows,
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

    const moraStats = this.computeMoraStatsFromLoans(
      loans,
      (loan) => loan.agent?.id === agentId
    );
    
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
    
    for (const [, clientLoans] of clientMap) {
      const client = clientLoans[0].client;
      
      for (const loan of clientLoans) {
        if (!client?.id) break;
      if (this.getLoanListingStatus(loan) !== 'active') continue;
      const end = loan.endDateAt ? new Date(loan.endDateAt) : null;
      if (!end) continue;
      const now = new Date();
      const daysLate =
        now > end ? Math.floor((now.getTime() - end.getTime()) / 86_400_000) : 0;
      if (daysLate > 0) {
        const prev = clientMaxDaysLate.get(client.id) ?? 0;
        if (daysLate > prev) {
          clientMaxDaysLate.set(client.id, daysLate);
        }
      }
      }

      const loanStatuses = clientLoans.map((loan) => this.getLoanListingStatus(loan));
      let status: 'active' | 'inactive' | 'approved' | 'rejected' | 'lead' | 'under_review' | 'unknown' = 'unknown';
      if (loanStatuses.includes('active')) status = 'active';
      else if (loanStatuses.includes('approved')) status = 'approved';
      else if (loanStatuses.includes('under_review')) status = 'under_review';
      else if (loanStatuses.includes('rejected')) status = 'rejected';
      else if (loanStatuses.includes('lead')) status = 'lead';
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
        diasMora: status === 'active' ? daysLate : 0,
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
  const crAgentTotal = this.countClientsWithCriticalDelay(clientMaxDaysLate);
  const mora15AgentTotal = this.countClientsWithMora15Delay(clientMaxDaysLate);
  const npAgentTotal = this.countClientsWithNoPayment30Delay(clientMaxDaysLate);
  const critical20AgentTotal = this.countClientsByLateThreshold(clientMaxDaysLate, 20, false);

  noPayment30 = crAgentTotal;
  mora15 = mora15AgentTotal;
  delinquentClients = npAgentTotal;
  critical20 = critical20AgentTotal;

  // Normalizar daysLate por fila al máximo del cliente
  for (const it of allResults) {
    const cid = Number(it?.client?.id);
    const maxLate = cid ? clientMaxDaysLate.get(cid) ?? 0 : 0;
    const lateValue = (it as any)?.status === 'active' ? maxLate : 0;
    it.daysLate = lateValue;
    (it as any).diasMora = lateValue;
  }

  // Filtro de mora para la tabla en findAllByAgent
  if (filters?.mora) {
    const code = String(filters.mora).toUpperCase();
    allResults = allResults.filter((it) => {
      if ((it as any)?.status !== 'active') return false;
      const dl = Number((it as any)?.daysLate ?? 0);
      if (!Number.isFinite(dl)) return false;
      if (code === 'NP') return dl > 30;
      if (code === 'M15') return dl > 15;
      if (code === 'CR') return dl >= 1;
      return false;
    });
  }
  
  const totalItems = allResults.length;
  const startIndex = (page - 1) * limit;
  const paginated = allResults.slice(startIndex, startIndex + limit);

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

private normalizePhoneForCountry(phone?: string | null, country?: { phoneCode?: string | null }): string | null {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (!digits) return null;
  const countryCode = String(country?.phoneCode ?? '').replace(/\D/g, '');
  if (!countryCode) return digits;
  const prefixedDouble = `57${countryCode}`;
  if (digits.startsWith(prefixedDouble)) {
    return digits.slice(2);
  }
  if (!digits.startsWith(countryCode)) {
    return `${countryCode}${digits}`;
  }
  return digits;
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
  if (sanitized.phone) {
    const normalizedPhone = this.normalizePhoneForCountry(String(sanitized.phone), country);
    sanitized.phone = normalizedPhone ?? String(sanitized.phone);
  }
  const client = this.clientRepository.create(sanitized);
  const saved = await this.clientRepository.save(client);

  // 7) (Opcional) WhatsApp onboarding
  // this.sendOnboardingIfConfigured(saved).catch(() => {});

  return saved;
}


}
