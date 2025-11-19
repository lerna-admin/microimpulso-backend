import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateLoanRequestDto } from './dto/create-loan-request.dto';
import { UpdateLoanRequestDto } from './dto/update-loan-request.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Not, Repository } from 'typeorm';
import { LoanRequest, LoanRequestStatus } from 'src/entities/loan-request.entity';
import { TransactionType, LoanTransaction } from 'src/entities/transaction.entity';
import { User } from 'src/entities/user.entity';
import { Notification } from 'src/notifications/notifications.entity';
import { BadRequestException } from '@nestjs/common';
import { Client, ClientStatus } from 'src/entities/client.entity';
import { CashMovement, CashMovementType } from 'src/entities/cash-movement.entity';
import { CashMovementCategory } from 'src/entities/cash-movement-category.enum';



@Injectable()
export class LoanRequestService {
  
  constructor(
    @InjectRepository(LoanRequest)
    private readonly loanRequestRepository: Repository<LoanRequest>,
    @InjectRepository(LoanTransaction)
    private readonly transactionRepository: Repository<LoanTransaction>,
    @InjectRepository(CashMovement)
    private readonly cashMovementRepository: Repository<CashMovement>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Notification)
    private notificationRepository: Repository<Notification>,
    @InjectRepository(Client)
    private clientRepository: Repository<Client>,
    
  ) {}
  
  
  
  async create(data: any): Promise<LoanRequest> {
  console.log('[LoanRequestService.create] INPUT =', JSON.stringify(data));

  try {
    // ────────────────────────────────────────────────────────────────
    // 0) CLIENTE: obtener ID y cargar con country (evita TypeError)
    // ────────────────────────────────────────────────────────────────
    const clientId =
      typeof data?.client === 'number'
        ? data.client
        : (data?.client as any)?.id;

    console.log('[create] parsed clientId =', clientId);

    if (!clientId) {
      console.log('[create] ERROR: falta client');
      throw new BadRequestException('Falta cliente en la solicitud.');
    }

    const client = await this.clientRepository.findOne({
      where: { id: clientId },
      relations: ['country'],
    });

    console.log(
      '[create] loaded client =',
      client ? { id: client.id, countryRelId: client.country?.id } : null,
    );

    if (!client) {
      console.log('[create] ERROR: cliente no encontrado');
      throw new BadRequestException('Cliente no encontrado.');
    }
    if (!client.country?.id) {
      console.log('[create] ERROR: cliente sin país');
      throw new BadRequestException('El cliente no tiene país asignado.');
    }

    const clientCountryId = Number(client.country.id);

    // ────────────────────────────────────────────────────────────────
    // 1) AGENTE: resolver
    //    - si NO viene -> elegir el MÁS DESOCUPADO en el MISMO PAÍS
    //    - si SÍ viene -> usarlo (validar existencia)
    // ────────────────────────────────────────────────────────────────
    let resolvedAgent: User | null = null;
    const incomingAgentRaw = data?.agent;
    const incomingAgent = (incomingAgentRaw ?? '').toString().trim();
    console.log('[create] incomingAgent (raw)=', incomingAgentRaw, 'trim=', incomingAgent);

    if (!incomingAgent) {
      // Estados que consideramos "abiertos" para medir carga
      const OPEN_STATES = ['new', 'approved', 'active'];
      console.log('[create] picking least-busy AGENT in country =', clientCountryId, 'openStates =', OPEN_STATES);

      // Query: usuarios con role=AGENT y branch del país del cliente,
      // con conteo de loans abiertos, orden ascendente (menos ocupados primero).
      const qb = this.userRepository
        .createQueryBuilder('user')
        .leftJoinAndSelect('user.branch', 'branch')
        .where('user.role = :role', { role: 'AGENT' })
        .andWhere('branch.countryId = :cid', { cid: clientCountryId })
        .leftJoin(
          this.loanRequestRepository.metadata.target as any,
          'lr',
          'lr.agentId = user.id AND lr.status IN (:...open)',
          { open: OPEN_STATES },
        )
        .groupBy('user.id')
        .orderBy('COUNT(lr.id)', 'ASC') // menos ocupados primero
        .addOrderBy('user.id', 'ASC')   // desempate estable
        .limit(1);

      resolvedAgent = await qb.getOne();
      console.log('[create] picked agent =', resolvedAgent ? { id: resolvedAgent.id, name: resolvedAgent.name } : null);

      if (!resolvedAgent) {
        console.log('[create] ERROR: no hay agentes disponibles en ese país');
        throw new BadRequestException('No hay agentes disponibles en el país del cliente.');
      }
      data.agent = resolvedAgent; // normaliza a objeto
    } else {
      const providedAgentId = Number(incomingAgent);
      console.log('[create] providedAgentId =', providedAgentId);

      if (!providedAgentId || Number.isNaN(providedAgentId)) {
        console.log('[create] ERROR: agent inválido');
        throw new BadRequestException('agent: ID de agente inválido.');
      }

      resolvedAgent = await this.userRepository.findOne({
        where: { id: providedAgentId },
      });
      console.log('[create] loaded provided agent =', resolvedAgent ? { id: resolvedAgent.id } : null);

      if (!resolvedAgent) {
        console.log('[create] ERROR: agente no existe');
        throw new BadRequestException('Agente no existe.');
      }
      data.agent = resolvedAgent; // normaliza a objeto
    }

    // ────────────────────────────────────────────────────────────────
    // 2) Chequeo opcional: ya tiene solicitud abierta (respetando tu lógica)
    // ────────────────────────────────────────────────────────────────
    const hasOpen = await this.loanRequestRepository.exist({
      where: {
        client: { id: clientId },
        status: In(['new', 'approved', 'active']), // ajusta si usas enum LoanRequestStatus
      },
    });
    console.log('[create] client has open request? =', hasOpen);
    // if (hasOpen) throw new BadRequestException('El cliente ya tiene una solicitud abierta.');

    // ────────────────────────────────────────────────────────────────
    // 3) Completar datos y persistir
    // ────────────────────────────────────────────────────────────────
    data.client = client;

    // Tu cálculo de 'mode' original
    const amountNum = Number(data?.amount ?? 0);
    const base = amountNum ? (amountNum < 1000 ? amountNum : amountNum / 1000) : 100;
    data.mode = String(base).concat('X1');

    // Normaliza fecha
    const endDate = data?.endDateAt ? new Date(data.endDateAt) : null;
    if (endDate && Number.isNaN(endDate.getTime())) {
      console.log('[create] WARNING: endDateAt inválida, se dejará null');
      data.endDateAt = null as any;
    }

    const payload: Partial<LoanRequest> = {
      status: data?.status ?? 'new',
      requestedAmount: data?.requestedAmount,
      endDateAt: data.endDateAt,
      amount: data?.amount,
      paymentDay: data?.paymentDay,
      type: data?.type,
      client: data.client,
      agent: data.agent,
      mode: data.mode,
      notes: data?.notes,
      // incluye otros campos si los estás enviando
    };

    console.log('[create] persist payload =', {
      ...payload,
      client: client.id,
      agent: (data.agent as User)?.id,
    });

    const entity = this.loanRequestRepository.create(payload);
    const saved = await this.loanRequestRepository.save(entity);

    console.log('[create] SUCCESS loanRequest saved =', { id: saved.id });
    return saved;
  } catch (err) {
    console.error('[create] ERROR =', err);
    console.error('[create] CONTEXT data =', JSON.stringify(data));
    throw err;
  }
}
  
  
  async renewLoanRequest(
    loanRequestId: number,
    amount?: number,
    newDate?: string,
    note?: string
  ): Promise<LoanRequest> {
    // 1. Buscar el préstamo original
    const originalLoan = await this.loanRequestRepository.findOne({
      where: { id: loanRequestId },
      relations: ['client', 'agent', 'agent.branch'],
    });
    if (!originalLoan) throw new Error('Loan request not found');
    const branchId = originalLoan.agent?.branch?.id;
    if (!branchId) {
      throw new BadRequestException('Loan renewal requires agent with branch assigned.');
    }
    
    // 2. Marcar el préstamo original como completado y renovado
    originalLoan.status = LoanRequestStatus.COMPLETED;
    originalLoan.isRenewed = true;
    originalLoan.renewedAt = new Date();
    
    // 3. Agregar nota de renovación
    const prevNotes = originalLoan.notes ? JSON.parse(originalLoan.notes) : [];
    const renewalNote = note
    ? note
    : `Renovado el ${new Date().toISOString()}`;
    prevNotes.push(renewalNote);
    originalLoan.notes = JSON.stringify(prevNotes);
    
    await this.loanRequestRepository.save(originalLoan);
    
    // 4. Crear el nuevo préstamo renovado
    const newNotes = [
      `Renovación desde préstamo ID ${originalLoan.id} el ${new Date().toISOString()}`
    ];
    const newLoan = this.loanRequestRepository.create({
      client: originalLoan.client,
      agent: originalLoan.agent,
      amount: (amount ?? originalLoan.amount) * 1.2,
      requestedAmount: amount ?? originalLoan.amount,
      status: LoanRequestStatus.RENEWED, // o 'renovado' si tienes ese estado
      type: originalLoan.type,
      mode: originalLoan.mode,
      mora: 0,
      endDateAt: newDate ? new Date(newDate) : undefined,
      isRenewed: false,
      notes: JSON.stringify(newNotes),
      paymentDay: originalLoan.paymentDay,
      repaymentAccount: originalLoan.repaymentAccount,
    });
    
    const savedNewLoan = await this.loanRequestRepository.save(newLoan);
    
    // 5. Registrar transacción de desembolso para el nuevo préstamo
    const disbursement = this.transactionRepository.create({
      loanRequest: savedNewLoan,
      Transactiontype: TransactionType.DISBURSEMENT,
      amount: savedNewLoan.requestedAmount,
      date: new Date(), // si tu entidad usa 'date' en vez de 'createdAt'
    });
    const savedDisbursement = await this.transactionRepository.save(disbursement);
    
    // Registrar la salida de caja para mantener coherencia con CashService
    const cashAmount = Number(savedNewLoan.requestedAmount ?? savedNewLoan.amount ?? 0);
    if (!Number.isFinite(cashAmount) || cashAmount <= 0) {
      throw new BadRequestException('Invalid amount for renewal cash movement.');
    }
    
    await this.cashMovementRepository.save({
      branchId,
      type: CashMovementType.SALIDA,
      category: CashMovementCategory.PRESTAMO,
      amount: cashAmount,
      reference: `Renovación préstamo ${originalLoan.id}`,
      transaction: { id: savedDisbursement.id } as any,
    });
    
    return savedNewLoan;
  }
  
  
  async findAll(
    limit: number = 10,
    page: number = 1,
    filters?: {
      id?: number;
      amount?: number;
      requestedAmount?: number;
      status?: LoanRequestStatus;
      type?: string;
      mode?: Date;
      mora?: number;
      endDateAt?: Date;
      paymentDay?: string;
      createdAt?: Date;
      updatedAt?: Date;
      clientId?: number;
      agentId?: number;
      branchId?: number;
    },
    currentUser?: User, // <- pásalo opcionalmente desde el controller
  ): Promise<{
    data: LoanRequest[];
    totalItems: number;
    totalPages: number;
    page: number;
    limit: number;
  }> {
    const qb = this.loanRequestRepository
    .createQueryBuilder('loan')
    .leftJoinAndSelect('loan.client', 'client')
    .leftJoinAndSelect('loan.agent',  'agent')
    .leftJoinAndSelect('agent.branch', 'branch')
    .select([
      'loan',
      'client',
      'agent',
      'branch',
    ]);
    
    /* ───── Scope por rol ─────
    AGENT   -> solo sus loans
    MANAGER -> por país (client.countryId = manager.branch.countryId)
    ADMIN   -> sin restricción
    */
    if (currentUser?.role === 'AGENT') {
      qb.andWhere('loan.agentId = :me', { me: currentUser.id });
    } else if (currentUser?.role === 'MANAGER') {
      // cargar manager con su branch para inferir countryId (sin repos extra)
      const me = await this.userRepository.findOne({
        where: { id: currentUser.id },
        relations: ['branch'],
      });
      if (!me?.branch?.id) {
        throw new BadRequestException('El manager no tiene branch asignada para inferir su país.');
      }
      const managerCountryId = (me.branch as any).countryId;
      qb.andWhere('client.countryId = :mc', { mc: managerCountryId });
    }
    // ADMIN/otros: sin restricción
    
    /* ───── Dynamic filters (igual que los tenías) ───── */
    if (filters?.id !== undefined)               qb.andWhere('loan.id = :id', { id: filters.id });
    if (filters?.amount !== undefined)           qb.andWhere('loan.amount = :amount', { amount: filters.amount });
    if (filters?.requestedAmount !== undefined)  qb.andWhere('loan.requestedAmount = :reqAmt', { reqAmt: filters.requestedAmount });
    if (filters?.status)                         qb.andWhere('loan.status = :status', { status: filters.status });
    if (filters?.type)                           qb.andWhere('loan.type   = :type',   { type:   filters.type });
    if (filters?.mode)                           qb.andWhere('loan.mode   = :mode',   { mode:   filters.mode });
    if (filters?.mora !== undefined)             qb.andWhere('loan.mora   = :mora',   { mora:   filters.mora });
    if (filters?.endDateAt)                      qb.andWhere('loan.endDateAt = :endDate', { endDate: filters.endDateAt });
    if (filters?.paymentDay)                     qb.andWhere('loan.paymentDay = :paymentDay', { paymentDay: filters.paymentDay });
    if (filters?.createdAt)                      qb.andWhere('loan.createdAt = :createdAt', { createdAt: filters.createdAt });
    if (filters?.updatedAt)                      qb.andWhere('loan.updatedAt = :updatedAt', { updatedAt: filters.updatedAt });
    if (filters?.clientId !== undefined)         qb.andWhere('loan.clientId = :clientId', { clientId: filters.clientId });
    if (filters?.agentId !== undefined)          qb.andWhere('loan.agentId  = :agentId',  { agentId:  filters.agentId });
    if (filters?.branchId !== undefined)         qb.andWhere('branch.id     = :branchId', { branchId: filters.branchId });
    
    qb.orderBy('loan.createdAt', 'DESC');
    
    if (limit > 0 && page > 0) qb.skip((page - 1) * limit).take(limit);
    
    const [data, totalItems] = await qb.getManyAndCount();
    
    return {
      data,
      totalItems,
      totalPages: limit > 0 ? Math.ceil(totalItems / limit) : 1,
      page,
      limit,
    };
  }
  
  
  async findAllByAgent(
    agentId: number,
    limit: number = 10,
    page: number = 1,
    filters?: {
      id?: number;
      amount?: number;
      requestedAmount?: number;
      status?: LoanRequestStatus;
      type?: string;
      mode?: Date;
      mora?: number;
      endDateAt?: Date;
      paymentDay?: string;
      createdAt?: Date;
      updatedAt?: Date;
      clientId?: number;
    },
    currentUser?: User, // <- opcional para scoping
  ): Promise<{
    data: LoanRequest[];
    totalItems: number;
    totalPages: number;
    page: number;
    limit: number;
  }> {
    const qb = this.loanRequestRepository
    .createQueryBuilder('loan')
    .leftJoinAndSelect('loan.client', 'client')
    .leftJoinAndSelect('loan.agent',  'agent')
    .leftJoinAndSelect('agent.branch', 'branch') // necesario para joins y (si quisieras) filtros por branch
    .leftJoinAndSelect('loan.transactions', 'tx')
    .select([
      'loan',
      'client',
      'agent.id',
      'agent.name',
      'agent.email',
      'agent.role',
      'tx.id',
      'tx.amount',
      'tx.Transactiontype',
      'tx.date',
      'tx.reference',
      'tx.daysLate',
    ])
    .where('loan.agentId = :agentId', { agentId });
    
    /* ───── Scope por rol ───── */
    if (currentUser?.role === 'AGENT') {
      if (currentUser.id !== agentId) {
        throw new BadRequestException('No autorizado para ver préstamos de otro agente');
      }
    } else if (currentUser?.role === 'MANAGER') {
      const me = await this.userRepository.findOne({
        where: { id: currentUser.id },
        relations: ['branch'],
      });
      if (!me?.branch?.id) {
        throw new BadRequestException('El manager no tiene branch asignada para inferir su país.');
      }
      const managerCountryId = (me.branch as any).countryId;
      // Filtramos por país a través del cliente (incluye TODAS las branches del país)
      qb.andWhere('client.countryId = :mc', { mc: managerCountryId });
    }
    // ADMIN/otros: sin restricción
    
    // ---------- dynamic filters (sin cambios estructurales) ----------
    if (filters?.id !== undefined)               qb.andWhere('loan.id = :id', { id: filters.id });
    if (filters?.amount !== undefined)           qb.andWhere('loan.amount = :amount', { amount: filters.amount });
    if (filters?.requestedAmount !== undefined)  qb.andWhere('loan.requestedAmount = :req', { req: filters.requestedAmount });
    if (filters?.status)                         qb.andWhere('loan.status = :status', { status: filters.status });
    if (filters?.type)                           qb.andWhere('loan.type = :type', { type: filters.type });
    if (filters?.mode)                           qb.andWhere('loan.mode = :mode', { mode: filters.mode });
    if (filters?.mora !== undefined)             qb.andWhere('loan.mora = :mora', { mora: filters.mora });
    if (filters?.endDateAt)                      qb.andWhere('loan.endDateAt = :endDate', { endDate: filters.endDateAt });
    if (filters?.paymentDay)                     qb.andWhere('loan.paymentDay = :pd', { pd: filters.paymentDay });
    if (filters?.createdAt)                      qb.andWhere('loan.createdAt = :ca', { ca: filters.createdAt });
    if (filters?.updatedAt)                      qb.andWhere('loan.updatedAt = :ua', { ua: filters.updatedAt });
    if (filters?.clientId !== undefined)         qb.andWhere('loan.clientId = :cid', { cid: filters.clientId });
    
    // paginación y orden
    qb.orderBy('loan.createdAt', 'DESC')
    .addOrderBy('tx.date', 'ASC')
    .skip((page - 1) * limit)
    .take(limit);
    
    const [rows, totalItems] = await qb.getManyAndCount();
    
    // helper exacto al tuyo
    const txTypeOf = (t: any) =>
      String(t?.type ?? t?.transactionType ?? t?.Transactiontype ?? '').toLowerCase();
    
    const data = rows.map(loan => {
      const repaymentTx = (loan.transactions ?? [])
      .filter(tx => txTypeOf(tx) === 'repayment')
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      const latestPayment = repaymentTx[0] ?? null;
      return { ...loan, latestPayment };
    });
    
    return {
      data,
      totalItems,
      totalPages: Math.ceil(totalItems / limit),
      page,
      limit,
    };
  }
  
  
  /** Returns the single open loan request for the client */
  async findOpenByClientId(clientId: number) {
    const openRequest = await this.loanRequestRepository.findOne({
      where: {
        client: { id: clientId },
        status: Not(In(['completed', 'rejected'])),
      },
      relations: { transactions: true, client: true },
      order: { createdAt: 'DESC' },
    });
    
    if (!openRequest) {
      throw new NotFoundException(
        `No open loan request found for client ${clientId}`,
      );
    }
    return openRequest;
  }
  
  async findAllByClient(clientId: number) {
    const openRequest = await this.loanRequestRepository.find({
      where: {
        client: { id: clientId }/**,
        status: Not(In(['completed', 'rejected'])),*/
      },
      relations: { transactions: true, client: true, agent: true},
      order: { createdAt: 'DESC' },
    });
    
    if (!openRequest) {
      throw new NotFoundException(
        `No open loan request found for client ${clientId}`,
      );
    }
    return openRequest;
  }
  
  async findById(id: number, currentUser?: User): Promise<LoanRequest | null> {
    const qb = this.loanRequestRepository
    .createQueryBuilder('loan')
    .leftJoinAndSelect('loan.client', 'client')
    .leftJoinAndSelect('loan.agent', 'agent')
    .leftJoinAndSelect('agent.branch', 'branch') // para joins y scoping
    .leftJoinAndSelect('loan.transactions', 'tx')
    .select([
      'loan',
      'client',
      'agent.id', 'agent.name', 'agent.email', 'agent.role',
      'tx.id', 'tx.amount', 'tx.Transactiontype', 'tx.date', 'tx.reference', 'tx.daysLate',
    ])
    .where('loan.id = :id', { id });
    
    // Scope por rol
    if (currentUser?.role === 'AGENT') {
      qb.andWhere('loan.agentId = :me', { me: currentUser.id });
    } else if (currentUser?.role === 'MANAGER') {
      const me = await this.userRepository.findOne({
        where: { id: currentUser.id },
        relations: ['branch'],
      });
      if (!me?.branch?.id) {
        throw new BadRequestException('El manager no tiene branch asignada para inferir su país.');
      }
      const managerCountryId = (me.branch as any).countryId;
      qb.andWhere('client.countryId = :mc', { mc: managerCountryId });
    }
    // ADMIN/otros: sin restricción
    
    return qb.getOne();
  }
  
  
  
  async update(id: number, updateLoanRequestDto: UpdateLoanRequestDto): Promise<LoanRequest> {
    console.log(id)
    const loanRequest = await this.loanRequestRepository.findOne({ where: { id },
      relations: ['agent', 'client', 'agent.branch', 'agent.branch.administrator'], });
      console.log(loanRequest)
      if (!loanRequest) {
        throw new NotFoundException(`loanRequest with ID ${id} not found`);
      }
      console.log(loanRequest.client)
      if (loanRequest.status === LoanRequestStatus.REJECTED){
        await this.clientRepository.update(loanRequest.client.id, {status: ClientStatus.INACTIVE});
      }
      const updated = Object.assign(loanRequest, updateLoanRequestDto);
      if(updated.status == LoanRequestStatus.APPROVED){
        await this.notificationRepository.save(
          this.notificationRepository.create({
            recipientId:  updated.agent.branch.administrator.id,
            category:     'loan',
            type:         'loan.approved',
            payload:      { author :  { id: updated.agent.id, name: updated.agent.name },  loanRequestId: loanRequest.id},
            description : `El agente ${updated.agent.name} ha aprobado una nueva solicitud, revisa las solicitudes pendientes de desembolso.`
          }),
          
          
        );
        
      }
      return await this.loanRequestRepository.save(updated);
    }
    
    
    
    // ────────────────────────────────────────────────────────────────────────────
    // Closing Summary SIN dayjs (no cambia tsconfig, ni otros archivos)
    
    async getClosingSummary(agentId: number) {
      // Get 'YYYY-MM-DD' for today's date in America/Bogota using only Intl.
      const getBogotaToday = (): string => {
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Bogota',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).formatToParts(new Date());
        const y = parts.find(p => p.type === 'year')!.value;
        const m = parts.find(p => p.type === 'month')!.value;
        const d = parts.find(p => p.type === 'day')!.value;
        return `${y}-${m}-${d}`; // e.g. 2025-08-25
      };
      
      const today = getBogotaToday();
      
      // ──────────────────────────────────────────────────────────────────────────
      // Cartera = SUM(disbursed FUNDED) - SUM(repayments de esos FUNDED)
      // ──────────────────────────────────────────────────────────────────────────
      const totalAmountRow = await this.loanRequestRepository
      .createQueryBuilder('loan')
      .select('COALESCE(SUM(loan.amount), 0)', 'totalAmount')
      .where('loan.status = :status', { status: LoanRequestStatus.FUNDED })
      .andWhere('loan.agentId = :agentId', { agentId })
      .getRawOne<{ totalAmount?: string }>();
      
      const totalRepaidRow = await this.transactionRepository
      .createQueryBuilder('tx')
      .innerJoin('tx.loanRequest', 'loan')
      .select(
        `COALESCE(SUM(CASE WHEN LOWER(tx.Transactiontype) = 'repayment' THEN tx.amount ELSE 0 END), 0)`,
        'totalRepaid'
      )
      // 👇 SOLO FUNDED para que coincida con los montos sumados arriba
      .where('loan.status = :status', { status: LoanRequestStatus.FUNDED })
      .andWhere('loan.agentId = :agentId', { agentId })
      .getRawOne<{ totalRepaid?: string }>();
      
      const totalAmount = Number(totalAmountRow?.totalAmount ?? 0);
      const totalRepaid = Number(totalRepaidRow?.totalRepaid ?? 0);
      const cartera = totalAmount - totalRepaid;
      
      // ──────────────────────────────────────────────────────────────────────────
      // Cobrado hoy: all REPAYMENT rows dated today for this agent
      // ──────────────────────────────────────────────────────────────────────────
      const cobradoRow = await this.transactionRepository
      .createQueryBuilder('tx')
      .innerJoin('tx.loanRequest', 'loan')
      .innerJoin('loan.agent', 'agent')
      .select('COALESCE(SUM(tx.amount), 0)', 'sum')
      .where(`LOWER(tx.Transactiontype) = 'repayment'`)
      .andWhere(`substr(tx.date, 1, 10) = :today`, { today })
      .andWhere('agent.id = :agentId', { agentId })
      .getRawOne<{ sum?: string }>();
      
      const cobrado = Number(cobradoRow?.sum ?? 0);
      
      // ──────────────────────────────────────────────────────────────────────────
      // Renovados hoy: loans with isRenewed = true and DATE(renewedAt) = today
      // ──────────────────────────────────────────────────────────────────────────
      const renewedTodayRow = await this.loanRequestRepository
      .createQueryBuilder('loan')
      .select([
        'COUNT(*) AS count',
        'COALESCE(SUM(loan.requestedAmount), 0) AS total',
      ])
      .where('loan.agentId = :agentId', { agentId })
      .andWhere('loan.isRenewed = :r', { r: true })
      .andWhere(`substr(loan.renewedAt, 1, 10) = :today`, { today })
      .getRawOne<{ count?: string; total?: string }>();
      
      const renovados = Number(renewedTodayRow?.count ?? 0);
      const valorRenovados = Number(renewedTodayRow?.total ?? 0);
      
      // ──────────────────────────────────────────────────────────────────────────
      // Nuevos hoy: disbursements today for this agent (count + amount)
      // Prefer loan.requestedAmount, fallback to tx.amount
      // ──────────────────────────────────────────────────────────────────────────
      const newRows = await this.transactionRepository
      .createQueryBuilder('tx')
      .innerJoin('tx.loanRequest', 'loan')
      .innerJoin('loan.agent', 'agent')
      .select([
        'COUNT(*) AS count',
        'COALESCE(SUM(COALESCE(loan.requestedAmount, tx.amount)), 0) AS total',
      ])
      .where(`LOWER(tx.Transactiontype) = 'disbursement'`)
      .andWhere(`substr(tx.date, 1, 10) = :today`, { today })
      .andWhere('agent.id = :agentId', { agentId })
      .getRawOne<{ count?: string; total?: string }>();
      
      const nuevos = Number(newRows?.count ?? 0);
      const valorNuevos = Number(newRows?.total ?? 0);
      
      // ──────────────────────────────────────────────────────────────────────────
      // Unique clients with FUNDED loans (stock metric)
      // ──────────────────────────────────────────────────────────────────────────
      const clientsRow = await this.loanRequestRepository
      .createQueryBuilder('loan')
      .innerJoin('loan.client', 'c')
      .select('COUNT(DISTINCT c.id)', 'clients')
      .where('loan.status = :status', { status: LoanRequestStatus.FUNDED })
      .andWhere('loan.agentId = :agentId', { agentId })
      .getRawOne<{ clients?: string }>();
      const clientes = Number(clientsRow?.clients ?? 0);
      
      return {
        cartera,         // esperado con tus datos: 160000
        cobrado,         // 440000
        clientes,        // 2
        renovados,       // 0
        valorRenovados,  // 0
        nuevos,          // 2
        valorNuevos,     // 500000
      };
    }
    
    
  }
