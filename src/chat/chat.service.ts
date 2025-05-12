import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, DeepPartial } from 'typeorm';
import { Client, ClientStatus } from '../entities/client.entity';
import { User } from '../entities/user.entity';
import { LoanRequest, LoanRequestStatus } from '../entities/loan-request.entity';
import { ChatMessage } from '../entities/chat-message.entity';
import axios from 'axios';

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

  /**
   * Handles incoming messages from WhatsApp webhook.
   * Ensures each message is linked to a client, loan request, and the responsible agent.
   */
  async processIncoming(payload: any) {
    try {
      const messageData = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      const phone = messageData?.from;
      const text = messageData?.text?.body;

      if (!phone || !text) {
        this.logger.warn('Missing phone number or message text.');
        return;
      }

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

      const activeLoan = client.loanRequests?.find(
        (lr) =>
          lr.status !== LoanRequestStatus.COMPLETED &&
          lr.status !== LoanRequestStatus.REJECTED,
      );

      let loanRequest = activeLoan;
      let assignedAgent: User | null = null;

      if (!loanRequest) {
        const agentsWithLoad = await this.userRepository
          .createQueryBuilder('user')
          .leftJoin(
            'user.loanRequests',
            'loanRequest',
            "loanRequest.status NOT IN ('COMPLETED', 'REJECTED')"
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

        loanRequest = this.loanRequestRepository.create({
          client,
          agent,
          status: LoanRequestStatus.NEW,
          amount: 0,
        });

        await this.loanRequestRepository.save(loanRequest);
      } else {
        assignedAgent = loanRequest.agent;
      }

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

  /**
   * Sends an outgoing WhatsApp message and stores it in the database.
   */
  async sendMessageToClient(clientId: number, message: string) {
    const client = await this.clientRepository.findOne({ where: { id: clientId } });

    if (!client || !client.phone) {
      throw new NotFoundException('Client not found or missing phone number.');
    }

    const accessToken = process.env.WHATSAPP_TOKEN || 'YOUR_DEFAULT_TOKEN';
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || 'YOUR_PHONE_NUMBER_ID';
    const to = client.phone;

    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: message },
    };

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };

    try {
      await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, payload, { headers });

      const latestLoan = await this.loanRequestRepository.findOne({
        where: { client: { id: client.id } },
        order: { createdAt: 'DESC' },
        relations: ['agent'],
      });

    const chatMessage = this.chatMessageRepository.create({
      content: message,
      direction: 'OUTGOING',
      client,
      agent: latestLoan?.agent ?? null,
      loanRequest: latestLoan ?? null,
    } as DeepPartial<ChatMessage>);

      await this.chatMessageRepository.save(chatMessage);

      return { success: true, to, message };
    } catch (error) {
      this.logger.error('Failed to send WhatsApp message:', error?.response?.data || error);
      throw new Error('Failed to send message via WhatsApp');
    }
  }

  /**
   * Retrieves all conversations for an agent.
   * Each conversation is grouped by loan request and includes all related messages.
   */
  async getAgentConversations(agentId: number) {
    const loans = await this.loanRequestRepository.find({
      where: {
        agent: { id: agentId },
        status: Not(LoanRequestStatus.COMPLETED),
      },
      relations: ['client'],
    });

    const conversations: {
      loanRequestId: number;
      client: Client;
      messages: ChatMessage[];
    }[] = [];

    for (const loan of loans) {
      const messages = await this.chatMessageRepository.find({
        where: { loanRequest: { id: loan.id } },
        order: { createdAt: 'ASC' },
      });
      conversations.push({
        loanRequestId: loan.id,
        client: loan.client,
        messages,
      });
    }

    return conversations;
  }
}
