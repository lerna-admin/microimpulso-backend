import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, In, Not, Repository } from 'typeorm';
import { Client, ClientStatus } from '../entities/client.entity';
import { User } from '../entities/user.entity';
import { LoanRequest, LoanRequestStatus } from '../entities/loan-request.entity';
import { Document } from '../entities/document.entity';
import { ChatMessage } from '../entities/chat-message.entity';
import axios from 'axios';
import { join } from 'path';
import { v4 as uuid } from 'uuid';
import { writeFileSync } from 'fs';
import { PDFDocument, rgb } from 'pdf-lib';
import * as fs from 'fs';
import * as FormData from 'form-data';
import { Readable } from 'stream';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  private TOKEN_TEMP: string =
    'EAAYqvtVC2P8BO30D6RkZBUDvUL9NVAt1TBhelMzZCdRTmFj5FMTw6HSu63aplgu30ZCpCnumer7NIv8dGi9tqtmWlClmH3T3mGba5tRJIYw2ZBL1dlQu05evPPkXaFg4NhEqqFCOk54cHboXhZAdyBmItWZAK9BOdQFG07ZCDJrXq4KT7uBVfQ0TA756pddhPo3FcASPfFh5Qi4FRv3KiVaJQk9wZBX2dNYZA8ZBJzQQHfyx7M9pzg978ZD';

  constructor(
    @InjectRepository(Client)
    private clientRepository: Repository<Client>,

    @InjectRepository(User)
    private userRepository: Repository<User>,

    @InjectRepository(Document)
    private documentRepository: Repository<Document>,

    @InjectRepository(LoanRequest)
    private loanRequestRepository: Repository<LoanRequest>,

    @InjectRepository(ChatMessage)
    private chatMessageRepository: Repository<ChatMessage>,
  ) {}

  async downloadAndStoreMediaori(mediaId: string, mimeType: string): Promise<string> {
    const token = process.env.WHATSAPP_TOKEN || this.TOKEN_TEMP;

    // Paso 1: Obtener la URL del archivo
    const metadata = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const fileUrl = metadata.data.url;

    // Paso 2: Descargar archivo
    const file = await axios.get(fileUrl, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
    });

    // Paso 3: Determinar extensión
    const extension = mimeType.includes('jpeg')
      ? 'jpg'
      : mimeType.includes('png')
        ? 'png'
        : mimeType.includes('pdf')
          ? 'pdf'
          : 'bin';

    const filename = `${uuid()}.${extension}`;
    const fullPath = join(__dirname, '..', '..', 'public', 'uploads', 'documents', filename);
    const relativePath = `/uploads/documents/${filename}`;

    writeFileSync(fullPath, file.data);

    return relativePath;
  }
  async downloadAndStoreMedia(mediaId: string, mimeType: string): Promise<string> {
    const token = this.TOKEN_TEMP;

    // Paso 1: Obtener la URL del archivo
    const metadata = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const fileUrl = metadata.data.url;

    // Paso 2: Descargar el archivo
    const response = await axios.get(fileUrl, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
    });

    const fileBuffer = response.data;

    // Detectar extensión desde MIME
    const extension = mimeType.split('/')[1] || 'bin';
    const finalFilename = `${uuid()}.${extension}`;
    const fullPath = join(__dirname, '..', '..', 'public', 'uploads', 'documents', finalFilename);
    const relativePath = `/uploads/documents/${finalFilename}`;

    // Guardar el archivo tal como llega
    writeFileSync(fullPath, fileBuffer);

    return relativePath;
  }

  async processIncoming(payload: any) {
    try {
      const messageData = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      const phone = messageData?.from;

      if (!phone) {
        this.logger.warn('Missing phone number.');
        return;
      }

      const isText = messageData?.type === 'text';
      const isImage = messageData?.type === 'image';
      const isDocument = messageData?.type === 'document';

      // 1️⃣ Load (or create) client
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

      // 2️⃣ Find or create active loan request
      let loanRequest = client.loanRequests?.find(
        (lr) => lr.status !== LoanRequestStatus.COMPLETED && lr.status !== LoanRequestStatus.REJECTED,
      );

      let assignedAgent: User | null = loanRequest?.agent ?? null;

      if (!loanRequest) {
        const leastBusy = await this.userRepository
          .createQueryBuilder('user')
          .leftJoin('user.loanRequests', 'loanRequest', "loanRequest.status NOT IN ('COMPLETED', 'REJECTED')")
          .where('user.role = :role', { role: 'AGENT' })
          .select(['user.id'])
          .addSelect('COUNT(loanRequest.id)', 'activeCount')
          .groupBy('user.id')
          .orderBy('activeCount', 'ASC')
          .getRawMany();

        if (!leastBusy.length) {
          this.logger.warn('No agents available.');
          return;
        }

        const agentId = leastBusy[0].user_id;
        //assignedAgent = await this.userRepository.findOne({ where: { id: agentId } });
        assignedAgent = await this.userRepository.findOne({ where: { id: agentId } });
        if (!assignedAgent) {
          console.log('No agent assigned, cannot create loan request.');
        } else {
          loanRequest = this.loanRequestRepository.create({
            client,
            agent: assignedAgent,
            status: LoanRequestStatus.NEW,
            amount: 0,
          });
          await this.loanRequestRepository.save(loanRequest);
        }
      }

      // 3️⃣ Handle media (if any)
      let content = '';
      if (isText) {
        content = messageData.text.body;
      } else if (isImage || isDocument) {
        const media = isImage ? messageData.image : messageData.document;
        const mimeType = media.mime_type;
        const mediaId = media.id;

        const url = await this.downloadAndStoreMedia(mediaId, mimeType); // ⬅️ función auxiliar
        const loanRequests = await this.loanRequestRepository.find({
          where: {
            client: { id: client.id },
            status: Not(In([LoanRequestStatus.COMPLETED, LoanRequestStatus.REJECTED])),
          },
        });

        const document = await this.documentRepository.save({
          type: mimeType,
          url,
          client: client,
          loanRequest: loanRequest ? loanRequests[0] : undefined, // ← esto asocia el documento a la solicitud activa

          createdAt: new Date(),
        });
        console.log(
          JSON.stringify(
            {
              type: mimeType,
              url,
              clientId: client.id,
              createdAt: new Date(),
            },
            null,
            4,
          ),
        );

        content = `📎 Documento recibido: [Ver archivo](/documents/view/${document.id})`;
      } else {
        this.logger.warn(`Unsupported message type: ${messageData?.type}`);
        return;
      }
      if (!assignedAgent) {
        console.log('No agent assigned, cannot create loan request.');
      } else {
        // 4️⃣ Save chat message
        const chatMessage = this.chatMessageRepository.create({
          content,
          direction: 'INCOMING',
          client,
          agent: assignedAgent,
          loanRequest,
        });

        await this.chatMessageRepository.save(chatMessage);
      }

      this.logger.log(`✅ Mensaje guardado de ${phone}`);
    } catch (error) {
      this.logger.error('❌ Error al procesar mensaje entrante:', error);
    }
  }

  async sendMessageToClient(clientId: number, message: string) {
    /* 1. Load client ------------------------------------------------------- */
    const client = await this.clientRepository.findOne({
      where: { id: clientId },
    });
    if (!client || !client.phone) {
      throw new NotFoundException('Client not found or missing phone number.');
    }

    /* 2. Latest loan-request (+ its agent) --------------------------------- */
    const loanRequest = await this.loanRequestRepository.findOne({
      where: { client: { id: client.id } },
      relations: ['agent'],
      order: { createdAt: 'DESC' },
    });
    const agent = loanRequest?.agent;

    /* 3. WhatsApp credentials --------------------------------------------- */
    const accessToken = this.TOKEN_TEMP;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '696358046884463';
    if (!accessToken || !phoneNumberId) {
      throw new Error('WhatsApp TOKEN or PHONE_NUMBER_ID env vars are not set.');
    }

    /* 4. Send message to WhatsApp ----------------------------------------- */
    const payload = {
      messaging_product: 'whatsapp',
      to: client.phone,
      type: 'text',
      text: { body: message },
    };

    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    /* 5. Persist the OUTGOING ChatMessage ---------------------------------- */
    const msgData: DeepPartial<ChatMessage> = {
      content: message,
      direction: 'OUTGOING',
      client,
      // add these only when they are defined
      ...(agent && { agent }),
      ...(loanRequest && { loanRequest }),
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
        createdAt: 'DESC',
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

  async sendSimulationToClient(clientId: number, file: Express.Multer.File) {
    // 1. Load client
    const client = await this.clientRepository.findOne({ where: { id: clientId } });
    if (!client || !client.phone) {
      throw new NotFoundException('Client not found or missing phone number.');
    }

    // 2. Load latest loan request (+ agent)
    const loanRequest = await this.loanRequestRepository.findOne({
      where: { client: { id: client.id } },
      relations: ['agent'],
      order: { createdAt: 'DESC' },
    });
    const agent = loanRequest?.agent;

    // 3. Create a readable stream from buffer
    const bufferStream = new Readable();
    bufferStream.push(file.buffer);
    bufferStream.push(null); // End of stream

    // 4. Prepare WhatsApp upload
    const accessToken = this.TOKEN_TEMP;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '696358046884463';

    if (!accessToken || !phoneNumberId) {
      throw new Error('Missing WhatsApp token or phone number ID');
    }

    const formData = new FormData();
    formData.append('file', bufferStream, {
      filename: file.originalname,
      contentType: file.mimetype,
    });
    formData.append('messaging_product', 'whatsapp');
    formData.append('type', file.mimetype);

    const mediaUpload = await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/media`, formData, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...formData.getHeaders(),
      },
    });

    const mediaId = mediaUpload.data.id;
    if (!mediaId) {
      throw new Error('Failed to upload media to WhatsApp.');
    }

    // 5. Send the image
    const mediaPayload = {
      messaging_product: 'whatsapp',
      to: client.phone,
      type: 'image',
      image: { id: mediaId },
    };

    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, mediaPayload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    // 6. Save the message
    const content = `📎 Simulation sent: ${file.originalname}`;

    const chatMessage = this.chatMessageRepository.create({
      content,
      direction: 'OUTGOING',
      client,
      ...(agent && { agent }),
      ...(loanRequest && { loanRequest }),
    });

    await this.chatMessageRepository.save(chatMessage);

    return { success: true, to: client.phone, file: file.originalname };
  }
  async sendContractToClient(loanRequestId: number) {
    const loan = await this.loanRequestRepository.findOne({
      where: { id: loanRequestId },
      relations: ['client', 'agent'],
    });

    if (!loan || !loan.client?.phone) {
      throw new NotFoundException('Loan or client not found');
    }

    const client = loan.client;
    const agent = loan.agent;

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]); // A4
    const fontSize = 12;

    const text = `
      LOAN CONTRACT
        
      Client: ${client.name}
      ID: ${client.document}
      Amount Requested: $${loan.requestedAmount?.toFixed(2)}
      Amount to Pay: $${loan.amount?.toFixed(2)}
      End Date: ${loan.endDateAt?.toISOString().split('T')[0]}
        
      This document certifies the agreement between Microimpulso and the client.
  `;

    page.drawText(text, { x: 50, y: 750, size: fontSize });

    const pdfBytes = await pdfDoc.save();
    const filename = `LoanContract-${loan.id}.pdf`;
    const filePath = join(__dirname, '..', '..', 'public', 'uploads', 'documents', filename);

    writeFileSync(filePath, pdfBytes); // lo guarda localmente para referencia

    const accessToken = this.TOKEN_TEMP;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '696358046884463';

    const bufferStream = new Readable();
    bufferStream.push(pdfBytes);
    bufferStream.push(null);

    const formData = new FormData();
    formData.append('file', bufferStream, {
      filename,
      contentType: 'application/pdf',
    });
    formData.append('messaging_product', 'whatsapp');
    formData.append('type', 'application/pdf');

    const mediaUpload = await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/media`, formData, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...formData.getHeaders(),
      },
    });

    const mediaId = mediaUpload.data.id;
    if (!mediaId) {
      throw new Error('Failed to upload contract to WhatsApp');
    }

    const messagePayload = {
      messaging_product: 'whatsapp',
      to: client.phone,
      type: 'document',
      document: {
        id: mediaId,
        filename,
      },
    };

    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, messagePayload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const content = `📎 Contract sent: ${filename}`;
    const chatMessage = this.chatMessageRepository.create({
      content,
      direction: 'OUTGOING',
      client,
      ...(agent && { agent }),
      loanRequest: loan,
    });
    await this.chatMessageRepository.save(chatMessage);

    return { success: true, sent: true };
  }
}
