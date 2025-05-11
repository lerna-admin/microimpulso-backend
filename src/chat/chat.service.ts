import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client, ClientStatus } from '../entities/client.entity';
import { User } from '../entities/user.entity';
import { LoanRequest, LoanRequestStatus } from '../entities/loan-request.entity';
import { ChatMessage } from '../entities/chat-message.entity';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @InjectRepository(Client)
    private clientRepository: Repository<Client>,

    @InjectRepository(User)
    private userRepository: Repository<User>,

    @InjectRepository(LoanRequest)
    private loanRequestRepository: Repository<LoanRequest>,

    @InjectRepository(ChatMessage)
    private chatMessageRepository: Repository<ChatMessage>,
  ) {}

  async processIncoming(payload: any) {
    try {
      const messageData = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      const phone = messageData?.from;
      const text = messageData?.text?.body;

      if (!phone || !text) {
        this.logger.warn('Missing phone number or message text.');
        return;
      }

      // Find or create the client based on phone number
      let client = await this.clientRepository.findOne({
        where: { phone },
        relations: ['loanRequests'],
      });

      if (!client) {
        client = this.clientRepository.create({
          phone,
          name: `Client ${phone}`,
          status: ClientStatus.PROSPECT,
        });
        await this.clientRepository.save(client);
      }

      // Find active loan request
      const activeLoan = client.loanRequests?.find(
        (lr) =>
          lr.status !== LoanRequestStatus.COMPLETED &&
          lr.status !== LoanRequestStatus.REJECTED,
      );

      let loanRequest = activeLoan;
      let assignedAgent: User | null = null;

      if (!loanRequest) {
        // Select the agent with the fewest active loan requests
        const agentsWithLoad = await this.userRepository
          .createQueryBuilder('user')
          .leftJoin(
            'user.loanRequests',
            'loanRequest',
            "loanRequest.status NOT IN ('COMPLETED', 'REJECTED')",
          )
          .where('user.role = :role', { role: 'AGENT' })
          .select(['user.id'])
          .addSelect('COUNT(loanRequest.id)', 'activeCount')
          .groupBy('user.id')
          .orderBy('activeCount', 'ASC')
          .getRawMany();

        if (!agentsWithLoad.length) {
          this.logger.warn('No agents available for assignment.');
          return;
        }

        const agentId = agentsWithLoad[0].user_id;
        const agent = await this.userRepository.findOne({ where: { id: agentId } });

        if (!agent) {
          this.logger.warn(`Agent with ID ${agentId} not found.`);
          return;
        }

        assignedAgent = agent;

        // Create a new loan request for the client
        loanRequest = this.loanRequestRepository.create({
          client,
          agent,
          status: LoanRequestStatus.NEW,
          amount: 0
        });

        await this.loanRequestRepository.save(loanRequest);
      } else {
        assignedAgent = loanRequest.agent;
      }

      // Save the incoming chat message
      const message = this.chatMessageRepository.create({
        content: text,
        direction: 'INCOMING',
        client,
        agent: assignedAgent,
        loanRequest,
      });

      await this.chatMessageRepository.save(message);

      this.logger.log(`✅ Message saved from ${phone}: "${text}"`);
    } catch (error) {
      this.logger.error('❌ Error processing incoming message:', error);
    }
  }
}
