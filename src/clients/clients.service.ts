import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client } from '../entities/client.entity';
import { LoanRequest, LoanRequestStatus } from 'src/entities/loan-request.entity';
import { filter } from 'rxjs';

@Injectable()
export class ClientsService {
/**
   * Free-text search across multiple Client fields.
   * - Case-insensitive using LOWER(..) LIKE :term (portable across SQLite/MySQL/Postgres).
   * - Matches: name, phone, email, document, documentType, address, notes, status.
   * - If `q` is numeric, also tries exact `id` match.
   * - Optional filter by `lead` (true/false) to separate imported vs platform-created.
   */
async search(
  q: string,
  opts: { limit?: number; offset?: number; lead?: boolean } = {},
): Promise<{ total: number; limit: number; offset: number; items: Client[] }> {
  if (!q || !q.trim()) throw new BadRequestException('Missing required search string "q".');

  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const leadFilter = typeof opts.lead === 'boolean' ? opts.lead : undefined;

  const qTrim = q.trim();
  const term = `%${qTrim.toLowerCase()}%`;
  const digits = qTrim.replace(/\D/g, '');
  const numericId = Number(qTrim);
  const looksNumeric = !Number.isNaN(numericId);

  //console.log(`[ClientsService.search] q="${qTrim}", limit=${limit}, offset=${offset}, lead=${leadFilter}`);
  //console.log(`[ClientsService.search] term="${term}", digits="${digits}", looksNumeric=${looksNumeric}`);

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

  if (typeof leadFilter === 'boolean') qb.andWhere('c.lead = :lead', { lead: leadFilter });

  qb.leftJoinAndSelect('c.agent', 'agent')
    .orderBy('c.updatedAt', 'DESC')
    .take(limit)
    .skip(offset);

  const [sql, parameters] = qb.getQueryAndParameters();
  //console.log(`[ClientsService.search] SQL:\n${sql}`);
  //console.log(`[ClientsService.search] PARAMS: ${JSON.stringify(parameters)}`);

  const started = Date.now();
  const [items, total] = await qb.getManyAndCount();
  const ms = Date.now() - started;

  //console.log(`[ClientsService.search] rows=${items.length}, total=${total}, time=${ms}ms`);
  if (items.length) console.log(`[ClientsService.search] first ids=${items.slice(0, 5).map(i => i.id).join(', ')}`);

  return { total, limit, offset, items };
}


  
  async update(id: number, data: any): Promise<Client> {
    const client = await this.clientRepository.findOne({
      where: { id },
      relations: ['agent'],
    });
    
    if (!client) {
      throw new NotFoundException('Client not found');
    }
    
    // Sólo permitimos actualizar estos campos
    const allowedFields = ['name', 'phone', 'email', 'document', 'documentType', 'address', 'status'];
    for (const key of allowedFields) {
      if (key in data) {
        client[key] = data[key];
      }
    }
    
    return this.clientRepository.save(client);
  }
  constructor(
    @InjectRepository(Client)
    private readonly clientRepository: Repository<Client>,
    
    @InjectRepository(LoanRequest)
    private readonly loanRequestRepository: Repository<LoanRequest>,
  ) { }

async findAll(
  limit: number = 10,
  page: number = 1,
  filters?: {
    status?: 'active' | 'inactive' | 'rejected' | 'prospect';
    document?: string;
    name?: string;
    mode?: string;
    type?: string;
    paymentDay?: string;
    agent?: number;
    branch?: number;
  }
): Promise<any> {
  // Cargamos TODOS los loans con relaciones necesarias
  const loans = await this.loanRequestRepository.find({
    relations: { client: true, transactions: true, agent: true },
    order: { createdAt: 'DESC' },
  });

  // Normaliza filtros numéricos
  if (filters?.agent)  filters.agent  = Number(filters.agent);
  if (filters?.branch) filters.branch = Number(filters.branch);

  const lower = (s?: string) => String(s ?? '').toLowerCase();
  const isActiveLoan = (s?: string) => {
    const st = lower(s);
    return st !== 'completed' && st !== 'rejected';
  };

  // Acumuladores de resumen (a nivel préstamo)
  let totalActiveAmountBorrowed = 0;
  let totalActiveRepayment = 0;
  const activeClientIds = new Set<number>(); // clientes con ≥1 préstamo activo
  let mora15 = 0;
  let critical20 = 0;
  let noPayment30 = 0;

  const now = new Date();
  const daysLateOf = (end?: Date | string | null) => {
    const d = end ? new Date(end) : null;
    return d && now > d ? Math.floor((now.getTime() - d.getTime()) / 86_400_000) : 0;
  };

  const items: any[] = [];

  for (const loan of loans) {
    const client = loan.client;
    if (!client) continue;

    // -------- Filtros a nivel CLIENTE (como antes) --------
    if (filters?.status === 'prospect') {
     // if (client.status !== 'prospect') continue;
    }
    if (filters?.document && !client.document?.includes(filters.document)) continue;
    if (filters?.name && !client.name?.toLowerCase().includes(filters.name.toLowerCase())) continue;

    // -------- Filtros a nivel PRÉSTAMO --------
    const derivedStatus: 'active' | 'inactive' =
      isActiveLoan(loan.status) ? 'active' : 'inactive';

    if (filters?.status && filters.status !== 'prospect') {
      // Soporta 'active' | 'inactive' | 'rejected' en el filtro
      if (filters.status === 'rejected') {
        if (lower(loan.status) !== 'rejected') continue;
      } else {
        if (filters.status !== derivedStatus) continue;
      }
    }

    if (filters?.mode && String(loan.mode) !== filters.mode) continue;
    if (filters?.type && loan.type !== filters.type) continue;
    if (filters?.paymentDay && loan.paymentDay !== filters.paymentDay) continue;
    if (filters?.agent && loan.agent?.id !== filters.agent) continue;
    if (filters?.branch && (loan.agent as any)?.branchId !== filters.branch) continue;

    // -------- Números por PRÉSTAMO (no agregados) --------
    const amountBorrowed = Number(loan.requestedAmount || 0); // base del préstamo
    const totalRepayment = (loan.transactions || [])
      .filter(t => lower(t.Transactiontype) === 'repayment')
      .reduce((s, t) => s + Number(t.amount), 0);
    const remainingAmount = amountBorrowed - totalRepayment;
    const daysLate = daysLateOf(loan.endDateAt);

    // Resumen global (por préstamo activo)
    if (derivedStatus === 'active') {
      totalActiveAmountBorrowed += amountBorrowed;
      totalActiveRepayment += totalRepayment;
      if (client.id) activeClientIds.add(client.id);

      if (daysLate > 0) {
        if (daysLate >= 30) noPayment30++;
        else if (daysLate > 20) critical20++;
        else if (daysLate > 15) mora15++;
      }
    }

    // -------- Item (MISMO SHAPE que antes) --------
    items.push({
      client,
      agent: loan.agent ? { id: loan.agent.id, name: loan.agent.name } : null,
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
      totalRepayment,     // pagos de este préstamo
      amountBorrowed,     // monto base de este préstamo
      remainingAmount,    // saldo de este préstamo
      daysLate,           // mora de este préstamo
      status: derivedStatus, // 'active' si loan ≠ completed/rejected
    });
  }

  // Paginación por PRÉSTAMO
  const totalItems = items.length;
  const startIndex = (page - 1) * limit;
  const data = items.slice(startIndex, startIndex + limit);

  return {
    page,
    limit,
    totalItems,
    totalPages: Math.ceil(totalItems / limit),
    totalActiveAmountBorrowed,
    totalActiveRepayment,
    activeClientsCount: activeClientIds.size, // clientes con ≥1 préstamo activo
    mora15,
    critical20,
    noPayment30,
    data,
  };
}



    
    
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
      }
    ): Promise<any> {
      // Fetch all loan requests assigned to the agent
      const loans = await this.loanRequestRepository.find({
        where: { agent: { id: agentId } },
        relations: { client: true, transactions: true },
        order: { createdAt: 'DESC' },
      });
      
      // Group loans by client
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
      
      // Process each client's loan group
      for (const [, clientLoans] of clientMap) {
        const client = clientLoans[0].client;
        
        const hasFunded = clientLoans.some(l => l.status === 'funded');
        const allCompleted = clientLoans.every(l => l.status === 'completed');
        const hasRejected = clientLoans.some(l => l.status === 'rejected');
        
        let status: 'active' | 'inactive' | 'rejected' | 'unknown' = 'unknown';
        if (hasFunded) status = 'active';
        else if (allCompleted) status = 'inactive';
        else if (hasRejected) status = 'rejected';
        if (status === 'unknown') continue;
        
        // Apply client-level filters
        if (filters?.status && filters.status.toLowerCase() !== status) continue;
        if (filters?.document && !client.document?.includes(filters.document)) continue;
        if (
          filters?.name &&
          !`${client.firstName || ''} ${client.lastName || ''}`
          .toLowerCase()
          .includes(filters.name.toLowerCase())
        ) continue;
        
        // Filter relevant loans by their status
        const relevantLoans = clientLoans.filter(l =>
          status === 'active' ? l.status === 'funded'
          : status === 'inactive' ? l.status === 'completed'
          : status === 'rejected' ? l.status === 'rejected'
          : false
        );
        
        let clientTotalRepayment = 0;
        let clientAmountBorrowed = 0;
        
        for (const loan of relevantLoans) {
          // Apply loan-level filters
          if (filters?.mode && String(loan.mode) !== filters.mode) continue;
          if (filters?.type && loan.type !== filters.type) continue;
          if (filters?.paymentDay && loan.paymentDay !== filters.paymentDay) continue;
          
          // Sum repayment transactions
          const totalRepayment = loan.transactions
          .filter(t => t.Transactiontype === 'repayment')
          .reduce((s, t) => s + Number(t.amount), 0);
          
          // Use loan.amount as base for amount borrowed
          const amountBorrowed = Number(loan.amount);
          
          const remainingAmount = amountBorrowed - totalRepayment;
          
          // Calculate late days
          const now = new Date();
          const endDate = loan.endDateAt ? new Date(loan.endDateAt) : null;
          const daysLate = endDate && now > endDate
          ? Math.floor((now.getTime() - endDate.getTime()) / 86_400_000)
          : 0;
          
          // Track late loans by severity
          if (status === 'active' && daysLate > 0) {
            if (daysLate >= 30) noPayment30++;
            else if (daysLate > 20) critical20++;
            else if (daysLate > 15) mora15++;
          }
          
          // Push loan details to response array
          allResults.push({
            client,
            agent : loan.agent.id,
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
          
          // Accumulate totals
          clientTotalRepayment += totalRepayment;
          clientAmountBorrowed += amountBorrowed;
        }
        
        // Only count totals for active clients
        if (status === 'active') {
          totalActiveAmountBorrowed += clientAmountBorrowed;
          totalActiveRepayment += clientTotalRepayment;
          activeClientsCount++;
        }
      }
      
      // Compute final summary values
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
        totalSaldoClientes, // ✅ New: remaining balance from all active loans
        activeClientsCount,
        mora15,
        critical20,
        noPayment30,
        data: paginated,
      };
    }
    
    
    
    
    
    
    
    
   async findOne(id: number): Promise<any | null> {
  const result = await this.clientRepository
    .createQueryBuilder('client')
    .innerJoin(
      'client.loanRequests',
      'loan',
      'loan.status IN (:...status)',
      { status: ['funded', 'renewed'] }
    )
    .innerJoin('loan.transactions', 'txn')
    .where('client.id = :id', { id })
    .select('client.id', 'clientId')
    .addSelect('client.name', 'clientName')
    .addSelect('loan.id', 'loanRequestId')
    .addSelect('loan.mode', 'loanMode')
    .addSelect('loan.type', 'loanType')
    .addSelect('loan.amount', 'totalAmountToPay')
    .addSelect(`
      CASE 
        WHEN loan."endDateAt" IS NOT NULL AND julianday('now') > julianday(loan."endDateAt")
        THEN CAST(julianday('now') - julianday(loan."endDateAt") AS INTEGER)
        ELSE 0
      END
    `, 'diasMora')
    .addSelect(`SUM(CASE WHEN txn."Transactiontype" = 'disbursement' THEN txn.amount ELSE 0 END)`, 'montoPrestado')
    .addSelect(`SUM(CASE WHEN txn."Transactiontype" = 'repayment' THEN txn.amount ELSE 0 END)`, 'totalPagado')
    .addSelect(`loan.amount - SUM(CASE WHEN txn."Transactiontype" = 'repayment' THEN txn.amount ELSE 0 END)`, 'pendientePorPagar')
    .groupBy('client.id')
    .addGroupBy('loan.id')
    .getRawOne();

  const fullClient = await this.clientRepository.findOne({
    where: { id },
    relations: { loanRequests: { transactions: true } },
  });

  if (fullClient) {
    // Mantén fuera solo los que no quieres mostrar
    fullClient.loanRequests = fullClient.loanRequests.filter(
      (loan) => loan.status !== 'completed' && loan.status !== 'rejected',
    );

    // ⬇️ Deriva el estado "activo" para la respuesta si hay funded/renewed
    const hasActiveLoan = fullClient.loanRequests.some(
      (lr) => lr.status === 'funded' || lr.status === 'renewed'
    );

    if (hasActiveLoan) {
      // OJO: no cambiamos la BD; solo la respuesta
      (fullClient as any).status = 'ACTIVE';
    }
  }

  return {
    ...result,
    client: fullClient,
  };
}

    
    async create(data: Partial<Client>): Promise<Client> {
      if (data.document || data.email) {
        const dup = await this.clientRepository.findOne({
          where: [
            data.document ? { document: data.document } : {},
            data.email    ? { email:    data.email    } : {},
          ],
        });
        
        if (dup) {
          throw new ConflictException(
            'A client with the same document or email already exists',
          );
        }
      }
      
      /* 2. Persist the new client ──────────────────────────────────── */
      const client = this.clientRepository.create({
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      
      return this.clientRepository.save(client);
    }

    
  }
  