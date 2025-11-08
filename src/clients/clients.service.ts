import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client } from '../entities/client.entity';
import { LoanRequest } from 'src/entities/loan-request.entity';
import { User } from 'src/entities/user.entity';
import { Country } from 'src/entities/country.entity';

@Injectable()
export class ClientsService {
  constructor(
    @InjectRepository(Client)
    private readonly clientRepository: Repository<Client>,

    @InjectRepository(LoanRequest)
    private readonly loanRequestRepository: Repository<LoanRequest>,

    // ⬇️ NUEVO: para scoping por rol/branch.country
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,

    // ⬇️ NUEVO: para validar que el country exista en create/update
    @InjectRepository(Country)
    private readonly countryRepository: Repository<Country>,
  ) {}
  
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
async findAll(
  limit: number = 10,
  page: number = 1,
  filters: {
    status?: 'active' | 'inactive' | 'rejected';
    document?: string;
    name?: string;
    mode?: string;
    type?: string;
    paymentDay?: string;
    agent?: number;
    branch?: number;     // branch del agente (filtro adicional opcional)
    countryId?: number;  // país del cliente (filtro adicional opcional)
  } = {},
  requesterUserId: number, // ⬅️ SOLO el id del usuario que hace la petición
): Promise<any> {
  // ───────────────────────────────────────────────────────────────
  // 0) Cargar el usuario solicitante y derivar su scope
  // ───────────────────────────────────────────────────────────────
  const requester = await this.userRepository.findOne({
    where: { id: requesterUserId },
    relations: ['branch', 'managerCountry'],
  });
  if (!requester) {
    throw new BadRequestException('Usuario solicitante no existe.');
  }

  const role = String(requester.role).toUpperCase();
  let adminBranchId: number | null = null;
  let managerCountryId: number | null = null;

  if (role === 'ADMIN') {
    adminBranchId = (requester as any)?.branch?.id ?? (requester as any)?.branchId ?? null;
    if (!adminBranchId) {
      throw new BadRequestException('El ADMIN no tiene branch asignada.');
    }
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
  // 1) Traer loans con joins para poder filtrar por agente/branch/país
  // ───────────────────────────────────────────────────────────────
  const loans = await this.loanRequestRepository.find({
    relations: { client: true, transactions: true, agent: { branch: true } },
    order: { createdAt: 'DESC' },
  });

  // ───────────────────────────────────────────────────────────────
  // 2) Helpers
  // ───────────────────────────────────────────────────────────────
  const lower = (s?: string) => String(s ?? '').toLowerCase();
  const isActiveLoan = (s?: string) => ['funded', 'renewed'].includes(lower(s));
  const txTypeOf = (t: any) =>
    lower((t?.type ?? t?.transactionType ?? t?.Transactiontype) as string);
  const now = new Date();
  const daysLateOf = (end?: Date | string | null) => {
    const d = end ? new Date(end) : null;
    return d && now > d ? Math.floor((now.getTime() - d.getTime()) / 86_400_000) : 0;
  };

  // ───────────────────────────────────────────────────────────────
  // 3) Agregadores y resultado
  // ───────────────────────────────────────────────────────────────
  let totalActiveAmountBorrowed = 0;
  let totalActiveRepayment = 0;
  const activeClientIds = new Set<number>();
  let mora15 = 0;
  let critical20 = 0;
  let noPayment30 = 0;

  const items: any[] = [];

  // ───────────────────────────────────────────────────────────────
  // 4) Iterar loans aplicando SCOPE por rol + filtros
  // ───────────────────────────────────────────────────────────────
  for (const loan of loans) {
    const client = loan.client;
    const agent  = loan.agent;
    const branch = agent?.branch as any;
    if (!client || !agent || !branch) continue;

    // ── SCOPE ──
    if (role === 'AGENT') {
      if (agent.id !== requester.id) continue;                   // agente: solo sus loans
    } else if (role === 'ADMIN') {
      if (branch.id !== adminBranchId) continue;                 // admin: loans de su branch
    } else if (role === 'MANAGER') {
      if ((branch as any).countryId !== managerCountryId) continue; // manager: loans de branches de su país
    }

    // ── FILTROS ADICIONALES (combinados con el scope) ──
    if (filters.countryId && client.country.id !== filters.countryId) continue;
    if (filters.branch && branch.id !== filters.branch) continue;
    if (filters.agent && agent.id !== filters.agent) continue;
    if (filters.document && !client.document?.includes(filters.document)) continue;
    if (filters.name && !client.name?.toLowerCase().includes(filters.name.toLowerCase())) continue;

    const derivedStatus: 'active' | 'inactive' =
      isActiveLoan(loan.status) ? 'active' : 'inactive';

    if (filters.status) {
      if (filters.status === 'rejected') {
        if (lower(loan.status) !== 'rejected') continue;
      } else {
        if (filters.status !== derivedStatus) continue;
      }
    }

    if (filters.mode && String(loan.mode) !== filters.mode) continue;
    if (filters.type && loan.type !== filters.type) continue;
    if (filters.paymentDay && loan.paymentDay !== filters.paymentDay) continue;

    // ── Métricas por loan ──
    const amountBorrowed  = Number(loan.amount ?? 0);
    const totalRepayment  = (loan.transactions ?? [])
      .filter((t) => txTypeOf(t) === 'repayment')
      .reduce((s, t) => s + Number(t?.amount ?? 0), 0);
    const remainingAmount = Math.max(0, amountBorrowed - totalRepayment);
    const daysLate        = daysLateOf(loan.endDateAt);

    if (derivedStatus === 'active') {
      totalActiveAmountBorrowed += amountBorrowed;
      totalActiveRepayment     += totalRepayment;
      if (client.id) activeClientIds.add(client.id);

      if (daysLate > 0) {
        if (daysLate >= 30)     noPayment30++;
        else if (daysLate > 20) critical20++;
        else if (daysLate > 15) mora15++;
      }
    }

    const lastTransaction = (loan.transactions ?? [])
      .filter(t => txTypeOf(t) === 'repayment')
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // Cada item es un LOAN (el cliente puede repetirse si tiene varios)
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
  }

  // ───────────────────────────────────────────────────────────────
  // 5) Orden y paginación
  // ───────────────────────────────────────────────────────────────
  items.sort((a, b) => {
    const aDate = a.loanRequest?.createdAt ?? a.client?.createdAt ?? new Date(0);
    const bDate = b.loanRequest?.createdAt ?? b.client?.createdAt ?? new Date(0);
    return new Date(bDate).getTime() - new Date(aDate).getTime();
  });

  const totalItems = items.length;
  const startIndex = (page - 1) * limit;
  const data = items.slice(startIndex, startIndex + limit);

  // ───────────────────────────────────────────────────────────────
  // 6) Totales de cartera (solo loans activos)
  // ───────────────────────────────────────────────────────────────
  const remainingTotal = items
    .filter((it) => it.loanRequest && isActiveLoan(it.loanRequest.status))
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
      status?: 'active' | 'inactive' | 'rejected';
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
    
    const allResults: any[] = [];
    let totalActiveAmountBorrowed = 0;
    let totalActiveRepayment = 0;
    let activeClientsCount = 0;
    let mora15 = 0;
    let critical20 = 0;
    let noPayment30 = 0;
    
    for (const [, clientLoans] of clientMap) {
      const client = clientLoans[0].client;
      
      const hasFunded = clientLoans.some((l) => l.status === 'funded');
      const allCompleted = clientLoans.every((l) => l.status === 'completed');
      const hasRejected = clientLoans.some((l) => l.status === 'rejected');
      
      let status: 'active' | 'inactive' | 'rejected' | 'unknown' = 'unknown';
      if (hasFunded) status = 'active';
      else if (allCompleted) status = 'inactive';
      else if (hasRejected) status = 'rejected';
      if (status === 'unknown') continue;
      
      if (filters?.status && filters.status.toLowerCase() !== status) continue;
      if (filters?.document && !client.document?.includes(filters.document))
        continue;
      if (
        filters?.name &&
        !`${client.firstName || ''} ${client.lastName || ''}`
        .toLowerCase()
        .includes(filters.name.toLowerCase())
      )
      continue;
      
      const relevantLoans = clientLoans.filter((l) =>
        status === 'active'
      ? l.status === 'funded'
      : status === 'inactive'
      ? l.status === 'completed'
      : status === 'rejected'
      ? l.status === 'rejected'
      : false,
    );
    
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
      
      if (status === 'active' && daysLate > 0) {
        if (daysLate >= 30) noPayment30++;
        else if (daysLate > 20) critical20++;
        else if (daysLate > 15) mora15++;
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
        WHEN loan."endDateAt" IS NOT NULL AND julianday('now') > julianday(loan."endDateAt")
        THEN CAST(julianday('now') - julianday(loan."endDateAt") AS INTEGER)
        ELSE 0
      END
      `,
    'diasMora',
  )
  .addSelect(
    `SUM(CASE WHEN txn."Transactiontype" = 'disbursement' THEN txn.amount ELSE 0 END)`,
    'montoPrestado',
  )
  .addSelect(
    `SUM(CASE WHEN txn."Transactiontype" = 'repayment' THEN txn.amount ELSE 0 END)`,
    'totalPagado',
  )
  .addSelect(
    `loan.amount - SUM(CASE WHEN txn."Transactiontype" = 'repayment' THEN txn.amount ELSE 0 END)`,
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
  let derivedClientStatus: 'ACTIVE' | 'INACTIVE' | 'PROSPECT' | undefined;
  
  if (fullClient) {
    const allLoans = fullClient.loanRequests ?? [];
    const hasAnyLoan = allLoans.length > 0;
    const hasActiveLoan = allLoans.some(
      (lr) => lr.status === 'funded' || lr.status === 'renewed',
    );
    
    if (hasActiveLoan) derivedClientStatus = 'ACTIVE';
    else if (hasAnyLoan) derivedClientStatus = 'INACTIVE';
    else derivedClientStatus = 'PROSPECT';
    
    // Si sigues queriendo ocultar en la respuesta los completados/rechazados:
    fullClient.loanRequests = allLoans.filter(
      (loan) => loan.status !== 'completed' && loan.status !== 'rejected',
    );
  }
  
  const clientResponse = fullClient
  ? {
    id: fullClient.id,
    name: fullClient.name,
    phone: fullClient.phone,
    phone2: (fullClient as any).phone2 ?? null,
    email: fullClient.email,
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
