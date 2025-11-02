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
    // ---------- Carga de préstamos como antes ----------
    const loans = await this.loanRequestRepository.find({
      relations: { client: true, transactions: true, agent: true },
      order: { createdAt: 'DESC' },
    });

    if (filters?.agent)  filters.agent  = Number(filters.agent);
    if (filters?.branch) filters.branch = Number(filters.branch);

    const lower = (s?: string) => String(s ?? '').toLowerCase();
    const isActiveLoan = (s?: string) => {
      const st = lower(s);
      return st !== 'completed' && st !== 'rejected';
    };

    // Resúmenes (por préstamo)
    let totalActiveAmountBorrowed = 0;
    let totalActiveRepayment = 0;
    const activeClientIds = new Set<number>();
    let mora15 = 0;
    let critical20 = 0;
    let noPayment30 = 0;

    const now = new Date();
    const daysLateOf = (end?: Date | string | null) => {
      const d = end ? new Date(end) : null;
      return d && now > d ? Math.floor((now.getTime() - d.getTime()) / 86_400_000) : 0;
    };

    const items: any[] = [];

    // ---------- Itera préstamos (idéntico a lo que ya tenías) ----------
    for (const loan of loans) {
      const client = loan.client;
      if (!client) continue;

      // Filtros a nivel cliente
      if (filters?.document && !client.document?.includes(filters.document)) continue;
      if (filters?.name && !client.name?.toLowerCase().includes(filters.name.toLowerCase())) continue;

      // Filtros a nivel préstamo
      const derivedStatus: 'active' | 'inactive' = isActiveLoan(loan.status) ? 'active' : 'inactive';

      if (filters?.status && filters.status !== 'prospect') {
        if (filters.status === 'rejected') {
          if (lower(loan.status) !== 'rejected') continue;
        } else {
          if (filters.status !== derivedStatus) continue;
        }
      } else if (filters?.status === 'prospect') {
        // Si pidieron 'prospect', los préstamos no aplican (prospect = sin solicitud)
        continue;
      }

      if (filters?.mode && String(loan.mode) !== filters.mode) continue;
      if (filters?.type && loan.type !== filters.type) continue;
      if (filters?.paymentDay && loan.paymentDay !== filters.paymentDay) continue;
      if (filters?.agent && loan.agent?.id !== filters.agent) continue;
      if (filters?.branch && (loan.agent as any)?.branchId !== filters.branch) continue;

      // Números por préstamo
      const amountBorrowed = Number(loan.requestedAmount || 0);
      const totalRepayment = (loan.transactions || [])
        .filter(t => lower(t.Transactiontype) === 'repayment')
        .reduce((s, t) => s + Number(t.amount), 0);
      const remainingAmount = amountBorrowed - totalRepayment;
      const daysLate = daysLateOf(loan.endDateAt);

      // Resumen global (solo préstamos activos)
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
        totalRepayment,
        amountBorrowed,
        remainingAmount,
        daysLate,
        status: derivedStatus, // 'active' | 'inactive'
      });
    }

    // ---------- Agregar clientes sin NINGUNA solicitud ----------
    // Regla:
    // - Si filters.status === 'prospect' -> siempre considerar SIN préstamo.
    // - Si NO hay status -> también se agregan.
    // - Si piden active/inactive/rejected -> por defecto NO se agregan (no hay préstamo con qué comparar).
    const includeClientsWithoutLoans =
      !filters?.status || filters.status === 'prospect';

    if (includeClientsWithoutLoans) {
      // LEFT JOIN a loanRequests y quedarnos con los que no tienen
      const qb = this.clientRepository
        .createQueryBuilder('client')
        .leftJoin('client.loanRequests', 'lr')
        .where('lr.id IS NULL');

      // Filtros a nivel cliente
      if (filters?.document) {
        qb.andWhere('client.document LIKE :doc', { doc: `%${filters.document}%` });
      }
      if (filters?.name) {
        qb.andWhere('LOWER(client.name) LIKE :name', { name: `%${filters.name.toLowerCase()}%` });
      }
      // Si explícitamente piden 'prospect', filtrar por estatus del cliente
      if (filters?.status === 'prospect') {
        qb.andWhere('LOWER(client.status) = :st', { st: 'prospect' });
      }

      // Nota: filtros loan/agent/branch NO aplican aquí porque no hay préstamo/agent asignado.

      const clientsWithoutLoans = await qb.getMany();

      for (const client of clientsWithoutLoans) {
        items.push({
          client,
          agent: null,
          loanRequest: null,
          totalRepayment: 0,
          amountBorrowed: 0,
          remainingAmount: 0,
          daysLate: 0,
          status: 'prospect' as const, // semánticamente claro para frontend
        });
      }
    }

    // ---------- Orden, paginación y resultado ----------
    // Mantén orden por fecha de creación: préstamos ya venían ordenados. Para los que no tienen préstamos,
    // no hay createdAt de loan; usamos createdAt del cliente para mezclar razonablemente.
    items.sort((a, b) => {
      const aDate = a.loanRequest?.createdAt ?? a.client?.createdAt ?? new Date(0);
      const bDate = b.loanRequest?.createdAt ?? b.client?.createdAt ?? new Date(0);
      return new Date(bDate).getTime() - new Date(aDate).getTime();
    });

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
      activeClientsCount: activeClientIds.size,
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

      // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
      // AQUI armamos el objeto client que enviaremos al frontend
      // incluyendo los campos nuevos.
      // Notas:
      // - usamos optional chaining porque fullClient podría ser null
      // - seguimos exponiendo loanRequests porque ya lo haces en la UI
      // - NO tocamos la forma de `result`, que parece usarse en otras partes
      // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

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

            // nuevos campos de referencia
            referenceName: (fullClient as any).referenceName ?? null,
            referencePhone: (fullClient as any).referencePhone ?? null,
            referenceRelationship: (fullClient as any).referenceRelationship ?? null,

            status: (fullClient as any).status,
            totalLoanAmount: fullClient.totalLoanAmount,
            notEligible: fullClient.notEligible,
            lead: fullClient.lead,

            // seguimos mandando loanRequests porque la vista de detalle las usa
            loanRequests: fullClient.loanRequests,
          }
        : null;

      console.log(clientResponse);
      return {
        ...result,
        client: clientResponse,
      };
    }



    // ============================================================
    // ===============  ENVÍO DE ONBOARDING WHATSAPP ==============
    // Helpers PRIVADOS dentro del servicio (sin imports nuevos)
    // ============================================================

    // <<< ADD: normaliza a MSISDN: solo dígitos con indicativo. Sin '+'
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
      // Si no, anteponemos Colombia (57) por defecto
      return `${fallbackCc}${raw.replace(/\D/g, '')}`;
    }

    // <<< ADD: dispara la plantilla si hay configuración. No lanza excepciones.
    private async sendOnboardingIfConfigured(client: Client): Promise<void> {
      try {
        const token  = process.env.WHATSAPP_TOKEN;
        const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_SENDER_ID;
        const template = process.env.WHATSAPP_ONBOARDING_TEMPLATE; // p.ej. onboarding_preaprobado_v1

        if (!token || !phoneId || !template) {
          // Falta config -> no enviamos, pero no rompemos el flujo
          // console.warn('[ClientsService] WhatsApp env vars missing, skipping onboarding message.');
          return;
        }

        const to = this.toMsisdnDigits(client.phone || '');
        if (!to) {
          // console.warn('[ClientsService] Client has no valid phone, skipping onboarding message.');
          return;
        }

        const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;

        const body = {
          messaging_product: 'whatsapp',
          to, // MSISDN sin '+'
          type: 'template',
          template: {
            name: template,
            language: { code: 'es' }, // tu plantilla se creó en "es"
            // sin components porque la plantilla no tiene botón ni parámetros
          },
        };

        // `fetch` global en Node 18+. Si tu runtime no lo trae, puedes migrarlo a axios si lo usas ya en tu proyecto.
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          console.warn(`[ClientsService] WhatsApp onboarding failed: ${res.status} ${res.statusText} - ${text}`);
        }
      } catch (err) {
        console.warn('[ClientsService] WhatsApp onboarding error:', (err as any)?.message || err);
      }
    }
    // ===================== FIN HELPERS WHATSAPP ====================



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

      const saved = await this.clientRepository.save(client);

      // <<< ADD: intentar envío de mensaje de onboarding (NO bloqueante)
      // Requisito: plantilla sin variables y sin botones, empresa Microimpulso SAS.
      // No usamos nombre del cliente ni monto; el copy está en tu plantilla.
      this.sendOnboardingIfConfigured(saved).catch(() => { /* ya se loguea adentro */ });

      return saved;
    }


}
