import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm'; 
import { DeepPartial, Repository } from 'typeorm';
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
  

async processIncoming(payload: any) {
  try {
    // 1️⃣ Extract phone number and text from the webhook payload
    const messageData = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const phone       = messageData?.from;
    const text        = messageData?.text?.body;

    if (!phone || !text) {
      this.logger.warn('Missing phone number or message text.');
      return;
    }

    // 2️⃣ Load (or create) the client, including loanRequests + their agents
    let client = await this.clientRepository.findOne({
      where: { phone },
      relations: ['loanRequests', 'loanRequests.agent'],
    });

    if (!client) {
      client = this.clientRepository.create({
        phone,
        name: `Client ${phone}`,
        status: ClientStatus.PROSPECT,
      });
      await this.clientRepository.save(client);
    }

    // 3️⃣ Look for an active loan request for this client
    const activeLoan = client.loanRequests?.find(
      (lr) =>
        lr.status !== LoanRequestStatus.COMPLETED &&
        lr.status !== LoanRequestStatus.REJECTED,
    );

    let loanRequest = activeLoan;
    let assignedAgent: User | null = null;

    // 4️⃣ If no active loan, pick the agent with the lightest workload
    if (!loanRequest) {
      const leastBusy = await this.userRepository
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

      if (!leastBusy.length) {
        this.logger.warn('No agents available for assignment.');
        return;
      }

      const agentId = leastBusy[0].user_id;
      const agent   = await this.userRepository.findOne({ where: { id: agentId } });
      if (!agent) {
        this.logger.warn(`Agent with ID ${agentId} not found.`);
        return;
      }

      assignedAgent = agent;

      // ▶️ Create the new loan request
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

   const chatMessageData: DeepPartial<ChatMessage> = {
    content: text,
    direction: 'INCOMING',
    client,
    agent: assignedAgent,
    loanRequest,
};
    const message = this.chatMessageRepository.create(chatMessageData);
    await this.chatMessageRepository.save(message);

    this.logger.log(`✅ Message saved from ${phone}: "${text}"`);
  } catch (error) {
    this.logger.error('❌ Error processing incoming message:', error);
  }
}
async sendMessageToClient(clientId: number, message: string) {
  // ───────────────────────────── 1.  Load the client
  const client = await this.clientRepository.findOne({
    where: { id: clientId },
  });

  if (!client || !client.phone) {
    throw new NotFoundException('Client not found or missing phone number.');
  }

  // ───────────────────────────── 2.  Load the most-recent loanRequest (+agent)
  const loanRequest = await this.loanRequestRepository.findOne({
    where: { client: { id: client.id } },
    relations: ['agent'],
    order: { createdAt: 'DESC' },
  });

  const agent = loanRequest?.agent ?? null;

  // ───────────────────────────── 3.  Validate WhatsApp credentials
  const accessToken   = process.env.WHATSAPP_TOKEN || 'EAAKJvNdqg2wBO8mmUFmvZBZBP7PkEHa0Q1AEEhNtBmZAUlxqxZAyLQcYwzFVfgRZA1rjSIINHrOZBE1UtgsmLP7MFLpZADXKZBkHnQWifx8I2YU6B9DU0xtv3ignVghOwjlmtruR8ZClqUbnZAZCTZCR7AJkyWkzJlBElvm3FZCfv4A4g0OxuajeI4ZCpsumbb9jEKqIw6aS8HfqSp96eZCqCGfIut6R2EZD';
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '631269870073158';

  if (!accessToken || !phoneNumberId) {
    throw new Error('WhatsApp TOKEN or PHONE_NUMBER_ID environment variables are not set.');
  }

  // ───────────────────────────── 4.  Send the message
  const payload = {
    messaging_product: 'whatsapp',
    to: client.phone,
    type: 'text',
    text: { body: message },
  };

  await axios.post(
    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    },
  );

  // ───────────────────────────── 5.  Persist the outgoing ChatMessage
  const msgData: DeepPartial<ChatMessage> = {
    content: message,
    direction: 'OUTGOING',
    client,
    agent,                 // ← always the agent from the latest loanRequest
    loanRequest: loanRequest ?? null,
  };

  const chatMessage = this.chatMessageRepository.create(msgData);
  await this.chatMessageRepository.save(chatMessage);

  return { success: true, to: client.phone, message };
}


async getAgentConversations(agentId: number) {
  // Obtener todos los mensajes que tengan agentId asignado
  const messages = await this.chatMessageRepository.find({
    where: {
      agent: { id: agentId },
    },
    relations: ['client'], // Asegura que traes el cliente relacionado
    order: {
      createdAt: 'ASC',
    },
  });

  const grouped = new Map<number, { client: Client; messages: ChatMessage[] }>();

  for (const msg of messages) {
    // Validación por si el mensaje no tiene cliente asociado
    if (!msg.client) continue;

    const clientId = msg.client.id;

    if (!grouped.has(clientId)) {
      grouped.set(clientId, {
        client: msg.client,
        messages: [],
      });
    }

    grouped.get(clientId)!.messages.push(msg);
  }

  return Array.from(grouped.values());
}
}
