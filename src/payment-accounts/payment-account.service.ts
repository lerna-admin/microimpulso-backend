import {
    Injectable,
    BadRequestException,
    NotFoundException,
  } from '@nestjs/common';
  import { InjectRepository } from '@nestjs/typeorm';
  import { Repository } from 'typeorm';
  import { PaymentAccount } from './payment-account.entity';
  
  interface AnyPayload {
    [key: string]: unknown;
  }
  
  @Injectable()
  export class PaymentAccountService {
    constructor(
      @InjectRepository(PaymentAccount)
      private readonly repo: Repository<PaymentAccount>,
    ) {}
  
    /* ───── CRUD helpers ───── */
  
    findAll(active?: string) {
      if (active === 'true')  return this.repo.find({ where: { isActive: true  } });
      if (active === 'false') return this.repo.find({ where: { isActive: false } });
      return this.repo.find();
    }
  
    /* inside PaymentAccountService ------------------------------------------- */
    async create(payload: any): Promise<PaymentAccount> {
        /* 1. Destructure & validate ---------------------------------------- */
        const {
          bankName,
          accountNumber,
          accountType,
          currency = 'COP',
          limit = 0,                 // ← uses the same name as in the entity
        } = payload;
      
        if (!bankName || !accountNumber || !accountType) {
          throw new BadRequestException(
            'bankName, accountNumber and accountType are required',
          );
        }
      
        /* 2. Build entity --------------------------------------------------- */
        const acct = this.repo.create({
          bankName,
          accountNumber,
          accountType,
          currency,
          limit,                     // ← matches @Column('decimal') limit
          dailyReceived: 0,
          isActive: true,
        });
      
        /* 3. Persist & return ---------------------------------------------- */
        return this.repo.save(acct);   // -> Promise<PaymentAccount>
      }
      
  
    async update(id: number, payload: AnyPayload) {
      const acct = await this.repo.findOne({ where: { id } });
      if (!acct) throw new NotFoundException('Payment account not found');
      Object.assign(acct, payload);
      return this.repo.save(acct);
    }
  
    async remove(id: number) {
      const acct = await this.repo.findOne({ where: { id } });
      if (!acct) throw new NotFoundException('Payment account not found');
      acct.isActive = false;
      return this.repo.save(acct);
    }
  
    /* ───── Business logic ───── */
  
    /** Pick an account that still has daily capacity for `amount` COP */
    async pickAccountFor(amount: number): Promise<PaymentAccount> {
      const today = new Date().toISOString().slice(0, 10);       // YYYY-MM-DD
  
      /* 1. Reset counters from previous days (cheap single query) */
      await this.repo
        .createQueryBuilder()
        .update()
        .set({ dailyReceived: 0 })
        .where('DATE(updatedAt) <> :today', { today })
        .execute();
  
      /* 2. Find an active account that can accept the amount */
      const acct = await this.repo
        .createQueryBuilder('a')
        .where('a.isActive = true')
        .andWhere('(a.dailyLimit - a.dailyReceived) >= :amt', { amt: amount })
        .orderBy('a.dailyReceived', 'ASC')   // simple load-balancing
        .getOne();
  
      if (!acct) throw new BadRequestException('No payment account can accept this amount today');
  
      /* 3. Reserve the capacity */
      acct.dailyReceived += amount;
      return this.repo.save(acct);
    }
  }
  