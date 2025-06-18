import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client } from '../entities/client.entity';
import { LoanRequest, LoanRequestStatus } from 'src/entities/loan-request.entity';

@Injectable()
export class ClientsService {
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


  
  // TODO HACER LOS MISMOS CAMBIOS DEL AGENT BY ID ACA PARA LOS DEMAS ROLES
 /**
 * Return a paginated list of clients, grouped by “representative” loan.
 * Adds a new status:  **prospect**  (client with zero loan requests).
 */
async findAll(
  limit: number = 10,
  page:  number = 1,
  filters?: {
    status?: 'active' | 'inactive' | 'rejected' | 'prospect';
    document?:   string;
    name?:       string;
    mode?:       string;
    type?:       string;
    paymentDay?: string;
  },
): Promise<any> {
  /* ──────────────── 1. Load data ──────────────── */
  const loans = await this.loanRequestRepository.find({
    where:     {},                               // no extra conditions
    relations: { client: true, transactions: true },
    order:     { createdAt: 'DESC' },
  });

  // every client row – light-weight, no joins
  const allClients = await this.clientRepository.find({
    select: ['id', 'name', 'document', 'createdAt'],
  });

  /* ──────────────── 2. Map loans by client ──────────────── */
  const clientMap = new Map<number, any[]>();    // clientId → LoanRequest[]
  for (const loan of loans) {
    const id = loan.client.id;
    if (!clientMap.has(id)) clientMap.set(id, []);
    clientMap.get(id)!.push(loan);
  }

  // add prospects (no loans)
  for (const client of allClients) {
    if (!clientMap.has(client.id)) clientMap.set(client.id, []); // empty array
  }

  /* ──────────────── 3. Accumulators ──────────────── */
  const allResults: any[] = [];
  let totalActiveAmountBorrowed = 0;
  let totalActiveRepayment      = 0;
  let activeClientsCount        = 0;
  let mora15 = 0, critical20 = 0, noPayment30 = 0;

  /* ──────────────── 4. Iterate per-client ──────────────── */
  for (const [ , clientLoans ] of clientMap) {
    const client = clientLoans.length ? clientLoans[0].client
                                      : allClients.find(c => !clientLoans.length && c.id);

    /* ---- determine status ---- */
    const hasFunded    = clientLoans.some(l => l.status === 'funded');
    const allCompleted = clientLoans.length > 0 && clientLoans.every(l => l.status === 'completed');
    const hasRejected  = clientLoans.some(l => l.status === 'rejected');

    let status: 'active' | 'inactive' | 'rejected' | 'prospect';
    if (clientLoans.length === 0)  status = 'prospect';
    else if (hasFunded)           status = 'active';
    else if (allCompleted)        status = 'inactive';
    else if (hasRejected)         status = 'rejected';
    else                          status = 'inactive';

    /* ---- filters that apply to *all* statuses ---- */
    if (filters?.status   && filters.status !== status)                   continue;
    if (filters?.document && !client.document?.includes(filters.document))continue;
    if (filters?.name     && !client.name.toLowerCase()
                                     .includes(filters.name.toLowerCase()))continue;

    /* ---- prospect rows: lightweight response ---- */
    if (status === 'prospect') {
      // if user requested loan-related filters, skip prospects
      if (filters?.mode || filters?.type || filters?.paymentDay) continue;

      allResults.push({
        client,
        loanRequest:       null,
        totalRepayment:    0,
        amountBorrowed:    0,
        remainingAmount:   0,
        daysLate:          0,
        status,
      });
      continue;
    }

    /* ---- select representative loan for non-prospects ---- */
    const sel = clientLoans.find(l =>
      status === 'active'   ? l.status === 'funded'    :
      status === 'inactive' ? l.status === 'completed' :
                              l.status === 'rejected'
    )!;

    /* ---- loan-related filters ---- */
    if (filters?.mode       && sel.mode       !== filters.mode)       continue;
    if (filters?.type       && sel.type       !== filters.type)       continue;
    if (filters?.paymentDay && sel.paymentDay !== filters.paymentDay) continue;

    /* ---- monetary calculations ---- */
    const totalRepayment = sel.transactions
      .filter(t => t.Transactiontype === 'repayment')
      .reduce((s, t) => s + +t.amount, 0);

    const amountBorrowed = sel.transactions
      .filter(t => t.Transactiontype === 'disbursement')
      .reduce((s, t) => s + +t.amount, 0);

    const remainingAmount = amountBorrowed - totalRepayment;

    /* ---- lateness & aggregates ---- */
    const now      = new Date();
    const endDate  = sel.endDateAt ? new Date(sel.endDateAt) : null;
    const daysLate = endDate && now > endDate
      ? Math.floor((now.getTime() - endDate.getTime()) / 86_400_000)
      : 0;

    if (status === 'active') {
      if      (daysLate >= 30) noPayment30++;
      else if (daysLate > 20)  critical20++;
      else if (daysLate > 15)  mora15++;

      totalActiveAmountBorrowed += amountBorrowed;
      totalActiveRepayment      += totalRepayment;
      activeClientsCount++;
    }

    /* ---- push result ---- */
    allResults.push({
      client,
      loanRequest: {
        id: sel.id,
        status: sel.status,
        amount: sel.amount,
        requestedAmount: sel.requestedAmount,
        createdAt: sel.createdAt,
        updatedAt: sel.updatedAt,
        type: sel.type,
        mode: sel.mode,
        mora: sel.mora,
        endDateAt: sel.endDateAt,
        paymentDay: sel.paymentDay,
        transactions: sel.transactions,
      },
      totalRepayment,
      amountBorrowed,
      remainingAmount,
      daysLate,
      status,
    });
  }

  /* ──────────────── 5. Pagination & return ──────────────── */
  const totalItems = allResults.length;
  const startIndex = (page - 1) * limit;
  const data       = allResults.slice(startIndex, startIndex + limit);

  return {
    page,
    limit,
    totalItems,
    totalPages: Math.ceil(totalItems / limit),
    totalActiveAmountBorrowed,
    totalActiveRepayment,
    activeClientsCount,
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
      .innerJoin('client.loanRequests', 'loan', 'loan.status = :status', { status: 'funded' })
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
        `
      SUM(CASE WHEN txn."Transactiontype" = 'disbursement' THEN txn.amount ELSE 0 END)
    `,
        'montoPrestado',
      )
      .addSelect(
        `
      SUM(CASE WHEN txn."Transactiontype" = 'repayment' THEN txn.amount ELSE 0 END)
    `,
        'totalPagado',
      )
      .addSelect(
        `
      loan.amount - SUM(CASE WHEN txn."Transactiontype" = 'repayment' THEN txn.amount ELSE 0 END)
    `,
        'pendientePorPagar',
      )
      .groupBy('client.id')
      .addGroupBy('loan.id')
      .getRawOne();
      
      const fullClient = await this.clientRepository.findOne({
        where: { id },
        relations: {
          loanRequests: {
            transactions: true,
          },
        },
      });
      
      if (fullClient) {
        fullClient.loanRequests = fullClient.loanRequests.filter(
          (loan) => loan.status !== 'completed' && loan.status !== 'rejected',
        );
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
  