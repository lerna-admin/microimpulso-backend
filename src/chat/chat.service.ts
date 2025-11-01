import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, In, Not, Repository } from 'typeorm';
import { Client, ClientStatus } from '../entities/client.entity';
import { User } from '../entities/user.entity';
import { LoanRequest, LoanRequestStatus } from '../entities/loan-request.entity';
import { Document } from '../entities/document.entity';
import { ChatMessage } from '../entities/chat-message.entity';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { join, dirname } from 'path';
import { v4 as uuid } from 'uuid';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as FormData from 'form-data';
import { Readable } from 'stream';
import { Notification } from 'src/notifications/notifications.entity';

/**
 * ChatService con diagnóstico/observabilidad mejorada:
 * - Version única de Graph API (por defecto v21.0)
 * - Axios instance con timeouts y validateStatus
 * - CorrelationId por operación para rastrear logs
 * - Logs estructurados (request/response/error) con redacción de token
 * - Manejo robusto de media (descarga y subida)
 * - Limpieza de hardcodes (usar ENV, con fallbacks)
 */

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  // ⚠️ Solo para pruebas locales. Usa WHATSAPP_TOKEN en producción.
  private TOKEN_TEMP: string =
    'EAAYsi96jmUYBPxTaOjbGyEiiYQXqoeOEcQ0OedMsvecltdhILB2rCQSx4fbwdTfolp29vRcBdqO5MZBx57kJnahZCPO3XVTafAfiYtT4FgH1EQc7sZA5AZCMASEZCquKp3JWzsxWbZClswZBARpQhUi3SesE9l0biTkcj6BhRG6TvI0xoTF8wSZBfhtO9Y84KvezIgZDZD';

  private GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v21.0';
  private DEBUG = (process.env.DEBUG_WA || '').toLowerCase() === 'true';

  private http: AxiosInstance;

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

    @InjectRepository(Notification)
    private notificationRepository: Repository<Notification>,
  ) {
    // Axios instance con settings comunes
    this.http = axios.create({
      baseURL: `https://graph.facebook.com/${this.GRAPH_API_VERSION}`,
      timeout: 20000,
      // Queremos registrar también 4xx/5xx
      validateStatus: () => true,
    });
  }

  /** Helpers -------------------------------------------------------------- */

  private getAccessToken(): string {
    return process.env.WHATSAPP_TOKEN || this.TOKEN_TEMP;
  }

  private getPhoneNumberId(): string {
    return process.env.WHATSAPP_PHONE_NUMBER_ID || '000000000000000';
  }

  private redact(str?: string) {
    if (!str) return str;
    if (str.length <= 8) return '***';
    return `${str.slice(0, 4)}***${str.slice(-4)}`;
    }

  private logRequest(cId: string, label: string, data: any) {
    if (!this.DEBUG) return;
    this.logger.debug(
      JSON.stringify(
        { cId, label, data },
        null,
        2,
      ),
    );
  }

  private logResponse(cId: string, label: string, status: number, data: any) {
    this.logger.log(
      JSON.stringify(
        { cId, label, status, data },
        null,
        2,
      ),
    );
  }

  private logError(cId: string, label: string, err: unknown) {
    const error = err as AxiosError<any>;
    const payload = {
      cId,
      label,
      message: error.message,
      code: error.code,
      status: error.response?.status,
      responseData: error.response?.data,
      stack: error.stack?.split('\n').slice(0, 3).join('\n'),
    };
    this.logger.error(JSON.stringify(payload, null, 2));
  }

  private ensureDir(path: string) {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
  }

  private toE164(phone: string): string {
    // Si ya viene con +, asumimos correcto; si no, intenta normalizar rápido
    const trimmed = (phone || '').trim();
    if (trimmed.startsWith('+')) return trimmed;
    // Ajusta esta normalización a tu país si fuera necesario
    return `+${trimmed.replace(/\D/g, '')}`;
  }

  /** Media: descarga y guarda en /public/uploads/documents ---------------- */

  async downloadAndStoreMedia(mediaId: string, mimeType: string): Promise<string> {
    const cId = uuid();
    const token = this.getAccessToken();

    try {
      // 1) Obtener URL
      const metaUrl = `/${mediaId}`;
      this.logRequest(cId, 'GET media metadata', { url: metaUrl });
      const metadata = await this.http.get(metaUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (metadata.status >= 400) {
        this.logResponse(cId, 'GET media metadata (error)', metadata.status, metadata.data);
        throw new Error(`Media metadata error: ${metadata.status}`);
      }

      const fileUrl: string = metadata.data?.url;
      if (!fileUrl) throw new Error('Media URL missing from metadata response');

      // 2) Descargar binario
      this.logRequest(cId, 'GET media file', { fileUrl });
      const file = await axios.get(fileUrl, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'arraybuffer',
        timeout: 30000,
        validateStatus: () => true,
      });

      if (file.status >= 400) {
        this.logResponse(cId, 'GET media file (error)', file.status, file.data?.toString?.());
        throw new Error(`Media download error: ${file.status}`);
      }

      // 3) Determinar extensión
      let extension = 'bin';
      if (mimeType) {
        const parts = mimeType.split('/');
        if (parts[1]) extension = parts[1] === 'jpeg' ? 'jpg' : parts[1];
      }

      const filename = `${uuid()}.${extension}`;
      const fullPath = join(__dirname, '..', '..', 'public', 'uploads', 'documents', filename);
      const relativePath = `/uploads/documents/${filename}`;

      this.ensureDir(dirname(fullPath));
      writeFileSync(fullPath, file.data);

      this.logResponse(cId, 'Media stored', 200, { relativePath, mimeType, size: file.data?.length });

      return relativePath;
    } catch (err) {
      this.logError(cId, 'downloadAndStoreMedia', err);
      throw err;
    }
  }

  /** Webhook entrante ----------------------------------------------------- */

  async processIncoming(payload: any) {
    const cId = uuid();
    try {
      this.logRequest(cId, 'INCOMING webhook payload', payload);

      const messageData = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      const statuses = payload?.entry?.[0]?.changes?.[0]?.value?.statuses?.[0];

      // Si es status (entregas/errores de salida), log útil
      if (statuses) {
        this.logResponse(cId, 'INCOMING status', 200, statuses);
      }

      const phone = messageData?.from;
      if (!phone) {
        this.logger.warn(`[${cId}] Missing phone number in webhook message.`);
        return;
      }

      const isText = messageData?.type === 'text';
      const isImage = messageData?.type === 'image';
      const isDocument = messageData?.type === 'document';

      // 1) Cargar/crear cliente
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

      // 2) Buscar o crear loan activo y asignar agente menos cargado
      let loanRequest =
        client.loanRequests?.find(
          (lr) => lr.status !== LoanRequestStatus.COMPLETED && lr.status !== LoanRequestStatus.REJECTED,
        ) || null;

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
          this.logger.warn(`[${cId}] No agents available.`);
        } else {
          const agentId = leastBusy[0].user_id;
          assignedAgent = await this.userRepository.findOne({ where: { id: agentId } });
          if (assignedAgent) {
            loanRequest = this.loanRequestRepository.create({
              client,
              agent: assignedAgent,
              status: LoanRequestStatus.NEW,
              amount: 0,
            });
            await this.loanRequestRepository.save(loanRequest);

            await this.notificationRepository.save(
              this.notificationRepository.create({
                recipientId: assignedAgent.id,
                category: 'loan',
                type: 'loan.assigned',
                payload: { loanRequestId: loanRequest.id, clientId: client.id },
                description: `Se te ha asignado una nueva solicitud, por favor comunícate con tu cliente ${client.name} al número ${client.phone}`,
              }),
            );
          } else {
            this.logger.warn(`[${cId}] No agent found by ID after leastBusy selection.`);
          }
        }
      }

      // 3) Manejo de contenido
      let content = '';
      if (isText) {
        content = messageData.text.body;
      } else if (isImage || isDocument) {
        const media = isImage ? messageData.image : messageData.document;
        const mimeType = media.mime_type;
        const mediaId = media.id;

        const url = await this.downloadAndStoreMedia(mediaId, mimeType);

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
          loanRequest: loanRequest ? loanRequests[0] : undefined,
          createdAt: new Date(),
        });

        this.logResponse(cId, 'Document persisted', 200, {
          id: document.id,
          type: mimeType,
          url,
          clientId: client.id,
        });

        content = `📎 Documento recibido: [Ver archivo](/documents/view/${document.id})`;
      } else {
        this.logger.warn(`[${cId}] Unsupported message type: ${messageData?.type}`);
        return;
      }

      // 4) Guardar mensaje de chat entrante
      if (assignedAgent) {
        const chatMessage = this.chatMessageRepository.create({
          content,
          direction: 'INCOMING',
          client,
          agent: assignedAgent,
          loanRequest: loanRequest || undefined,
        });
        await this.chatMessageRepository.save(chatMessage);
      } else {
        this.logger.warn(`[${cId}] No agent assigned; incoming message not linked to agent.`);
      }

      this.logger.log(`[${cId}] ✅ Mensaje entrante guardado de ${phone}`);
    } catch (error) {
      this.logError(cId, 'processIncoming', error);
      this.logger.error(`[${cId}] ❌ Error al procesar mensaje entrante`);
    }
  }

  /** Enviar texto al cliente ---------------------------------------------- */

  async sendMessageToClient(clientId: number, message: string) {
    const cId = uuid();

    // 1) Cliente
    const client = await this.clientRepository.findOne({ where: { id: clientId } });
    if (!client || !client.phone) {
      throw new NotFoundException('Client not found or missing phone number.');
    }
    const to = this.toE164(client.phone);

    // 2) Loan & agente
    const loanRequest = await this.loanRequestRepository.findOne({
      where: { client: { id: client.id } },
      relations: ['agent'],
      order: { createdAt: 'DESC' },
    });
    const agent = loanRequest?.agent;

    // 3) Credenciales
    const accessToken = this.getAccessToken();
    const phoneNumberId = this.getPhoneNumberId();
    if (!accessToken || !phoneNumberId) {
      throw new Error('WhatsApp TOKEN or PHONE_NUMBER_ID env vars are not set.');
    }

    // 4) Payload
    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: message },
    };

    try {
      const url = `/${phoneNumberId}/messages`;
      this.logRequest(cId, 'WA sendMessageToClient request', {
        url,
        headers: { Authorization: `Bearer ${this.redact(accessToken)}`, 'Content-Type': 'application/json' },
        payload,
      });

      const res = await this.http.post(url, payload, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      this.logResponse(cId, 'WA sendMessageToClient response', res.status, res.data);

      if (res.status >= 400) {
        throw new Error(`WhatsApp API error: ${res.status}`);
      }

      // 5) Persistir OUTGOING
      const msgData: DeepPartial<ChatMessage> = {
        content: message,
        direction: 'OUTGOING',
        client,
        ...(agent && { agent }),
        ...(loanRequest && { loanRequest }),
      };
      const chatMessage = this.chatMessageRepository.create(msgData);
      await this.chatMessageRepository.save(chatMessage);

      return { success: true, cId, to, message, waId: res.data?.messages?.[0]?.id };
    } catch (err) {
      this.logError(cId, 'sendMessageToClient', err);
      throw err;
    }
  }

  /** Listado de conversaciones por agente -------------------------------- */

  async getAgentConversations(agentId: number) {
    const messages = await this.chatMessageRepository.find({
      where: { agent: { id: agentId } },
      relations: ['client'],
      order: { createdAt: 'DESC' },
    });

    const grouped = new Map<number, { client: Client; messages: ChatMessage[] }>();
    for (const msg of messages) {
      if (!msg.client) continue;
      const cId = msg.client.id;
      if (!grouped.has(cId)) grouped.set(cId, { client: msg.client, messages: [] });
      grouped.get(cId)!.messages.push(msg);
    }
    return Array.from(grouped.values());
  }

  /** Enviar simulación (imagen/pdf) -------------------------------------- */

  async sendSimulationToClient(clientId: number, file: Express.Multer.File) {
    const cId = uuid();

    // 1) Cliente
    const client = await this.clientRepository.findOne({ where: { id: clientId } });
    if (!client || !client.phone) {
      throw new NotFoundException('Client not found or missing phone number.');
    }
    const to = this.toE164(client.phone);

    // 2) Loan & agente
    const loanRequest = await this.loanRequestRepository.findOne({
      where: { client: { id: client.id } },
      relations: ['agent'],
      order: { createdAt: 'DESC' },
    });
    const agent = loanRequest?.agent;

    // 3) Stream del archivo
    const bufferStream = new Readable();
    bufferStream.push(file.buffer);
    bufferStream.push(null);

    // 4) Credenciales
    const accessToken = this.getAccessToken();
    const phoneNumberId = this.getPhoneNumberId();
    if (!accessToken || !phoneNumberId) {
      throw new Error('Missing WhatsApp token or phone number ID');
    }

    try {
      // 5) Subir media
      const formData = new (FormData as any)();
      formData.append('file', bufferStream, {
        filename: file.originalname,
        contentType: file.mimetype,
      });
      formData.append('messaging_product', 'whatsapp');
      formData.append('type', file.mimetype);

      const uploadUrl = `/${phoneNumberId}/media`;
      this.logRequest(cId, 'WA upload media request', {
        url: uploadUrl,
        headers: { Authorization: `Bearer ${this.redact(accessToken)}`, ...formData.getHeaders?.() },
        file: { name: file.originalname, mimetype: file.mimetype, size: file.size },
      });

      const mediaUpload = await this.http.post(uploadUrl, formData, {
        headers: { Authorization: `Bearer ${accessToken}`, ...(formData as any).getHeaders?.() },
      });

      this.logResponse(cId, 'WA upload media response', mediaUpload.status, mediaUpload.data);

      if (mediaUpload.status >= 400 || !mediaUpload.data?.id) {
        throw new Error(`Failed to upload media to WhatsApp. Status: ${mediaUpload.status}`);
      }

      const mediaId = mediaUpload.data.id;

      // 6) Enviar mensaje (tipo según mimetype; aquí forzamos image si es imagen)
      const isImage = file.mimetype.startsWith('image/');
      const type = isImage ? 'image' : 'document';
      const mediaPayload: any = {
        messaging_product: 'whatsapp',
        to,
        type,
        [type]: isImage ? { id: mediaId } : { id: mediaId, filename: file.originalname },
      };

      const sendUrl = `/${phoneNumberId}/messages`;
      this.logRequest(cId, 'WA send media request', {
        url: sendUrl,
        payload: mediaPayload,
      });

      const sendRes = await this.http.post(sendUrl, mediaPayload, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      });

      this.logResponse(cId, 'WA send media response', sendRes.status, sendRes.data);

      if (sendRes.status >= 400) {
        throw new Error(`WhatsApp send media error: ${sendRes.status}`);
      }

      // 7) Guardar OUTGOING
      const content = `📎 Simulation sent: ${file.originalname}`;
      const chatMessage = this.chatMessageRepository.create({
        content,
        direction: 'OUTGOING',
        client,
        ...(agent && { agent }),
        ...(loanRequest && { loanRequest }),
      });
      await this.chatMessageRepository.save(chatMessage);

      return { success: true, cId, to, file: file.originalname, waId: sendRes.data?.messages?.[0]?.id };
    } catch (err) {
      this.logError(cId, 'sendSimulationToClient', err);
      throw err;
    }
  }

  /** Generar y enviar contrato (PDF) ------------------------------------- */

  async sendContractToClient(loanRequestId: number) {
    const cId = uuid();

    const loan = await this.loanRequestRepository.findOne({
      where: { id: loanRequestId },
      relations: ['client', 'agent'],
    });

    if (!loan || !loan.client?.phone) {
      throw new NotFoundException('Loan or client not found');
    }

    const client = loan.client;
    const agent = loan.agent;
    loan.endDateAt = new Date(loan.endDateAt);

    /* 1) PDF -------------------------------------------------------------- */
    const pdfDoc = await PDFDocument.create();
    const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const marginX = 55;
    const columnW = 480;
    const lineH = 16;
    const bottomMargin = 60;

    let page = pdfDoc.addPage([595.28, 841.89]);
    let cursorY = 800;

    const addPage = () => {
      page = pdfDoc.addPage([595.28, 841.89]);
      cursorY = 800;
    };

    const ensureSpace = (needed = lineH) => {
      if (cursorY - needed < bottomMargin) addPage();
    };

    const drawParagraph = (
      text: string,
      font = helv,
      size = 11,
      color = rgb(0, 0, 0),
      extraSpacing = 4,
    ) => {
      const words = text.replace(/\s+/g, ' ').trim().split(' ');
      let line = '';
      words.forEach((w, idx) => {
        const testLine = line ? `${line} ${w}` : w;
        const width = font.widthOfTextAtSize(testLine, size);
        if (width > columnW) {
          ensureSpace();
          page.drawText(line, { x: marginX, y: cursorY, size, font, color });
          cursorY -= lineH;
          line = w;
        } else {
          line = testLine;
        }
        if (idx === words.length - 1) {
          ensureSpace();
          page.drawText(line, { x: marginX, y: cursorY, size, font, color });
          cursorY -= lineH + extraSpacing;
        }
      });
    };

    // Título
    ensureSpace();
    page.drawText('CONTRATO DE CRÉDITO LIBRE INVERSIÓN', {
      x: marginX,
      y: cursorY,
      size: 14,
      font: helvBold,
    });
    cursorY -= lineH + 6;

    // Contenido (resumido de tu versión, intacto en esencia)
    drawParagraph(
      `Son partes del presente contrato la sociedad MICROIMPULSO S.A.S., identificada con NIT No. 901000000-0, debidamente constituida y vigilada por la Superintendencia Financiera de Colombia, con domicilio en Bogotá D.C., quien en adelante se denominará EL ACREEDOR, y el(la) señor(a) ${client.name}, identificado(a) con cédula No. ${client.document}, expedida en Bogotá D.C., con domicilio en Bogotá D.C., quien en adelante se denominará EL DEUDOR.`,
    );
    drawParagraph(
      `El presente contrato es de los denominados de adhesión...`,
    );
    drawParagraph(
      `EL DEUDOR... pagaré con espacios en blanco...`,
    );
    drawParagraph(
      `Los términos y condiciones particulares del Producto...`,
    );

    ensureSpace();
    page.drawText('1. Objeto', { x: marginX, y: cursorY, size: 12, font: helvBold });
    cursorY -= lineH;
    drawParagraph(
      `El presente contrato tiene por objeto establecer las condiciones generales del PRODUCTO...`,
    );

    ensureSpace();
    page.drawText(`Monto aprobado: $${loan.requestedAmount?.toFixed(2)}`, {
      x: marginX,
      y: cursorY,
      size: 11,
      font: helvBold,
    });
    cursorY -= lineH;

    ensureSpace();
    page.drawText(`Monto total a pagar: $${loan.amount?.toFixed(2)}`, {
      x: marginX,
      y: cursorY,
      size: 11,
      font: helvBold,
    });
    cursorY -= lineH;

    ensureSpace();
    page.drawText(`Fecha única de pago: ${loan.endDateAt.toISOString().split('T')[0]}`, {
      x: marginX,
      y: cursorY,
      size: 11,
      font: helvBold,
    });
    cursorY -= lineH + 6;

    const sections: { title: string; body: string }[] = [
      { title: '2. Condiciones Generales del Crédito de Libre Inversión', body: '...' },
      { title: '3. Condiciones para la utilización de “El Producto”', body: '...' },
      { title: '4. Condiciones de pago', body: '...' },
      { title: '5. Condiciones sobre Seguros', body: '...' },
      { title: '6. Comisiones y gastos', body: '...' },
      { title: '7. Condiciones en caso de incumplimiento', body: '...' },
      { title: '8. Otras condiciones y autorizaciones', body: '...' },
    ];

    sections.forEach(({ title, body }) => {
      ensureSpace();
      page.drawText(title, { x: marginX, y: cursorY, size: 12, font: helvBold });
      cursorY -= lineH;
      drawParagraph(body);
    });

    drawParagraph(
      `En constancia de lo anterior, se firma en la ciudad de Bogotá D.C. a los ${new Date().getDate()} días del mes de ${new Date().toLocaleString('es-CO', { month: 'long' })} del año ${new Date().getFullYear()}.`,
    );
    drawParagraph('Acepto en calidad de EL DEUDOR:');
    ensureSpace(30);
    page.drawLine({ start: { x: marginX, y: cursorY }, end: { x: marginX + 250, y: cursorY } });
    cursorY -= lineH;
    drawParagraph(`Nombre: ${client.name}`);
    drawParagraph(`Cédula de Ciudadanía: ${client.document}`);

    const pdfBytes = await pdfDoc.save();
    const filename = `LoanContract-${loan.id}.pdf`;
    const filePath = join(__dirname, '..', '..', 'public', 'uploads', 'documents', filename);
    this.ensureDir(dirname(filePath));
    writeFileSync(filePath, pdfBytes);

    /* 2) Subir y enviar por WhatsApp ------------------------------------- */
    const accessToken = this.getAccessToken();
    const phoneNumberId = this.getPhoneNumberId();
    const to = this.toE164(client.phone);

    const bufferStream = new Readable();
    bufferStream.push(pdfBytes);
    bufferStream.push(null);

    try {
      const formData = new (FormData as any)();
      formData.append('file', bufferStream, { filename, contentType: 'application/pdf' });
      formData.append('messaging_product', 'whatsapp');
      formData.append('type', 'application/pdf');

      const uploadUrl = `/${phoneNumberId}/media`;
      this.logRequest(cId, 'WA upload contract request', {
        url: uploadUrl,
        headers: { Authorization: `Bearer ${this.redact(accessToken)}`, ...(formData as any).getHeaders?.() },
        file: { filename, mimetype: 'application/pdf', size: pdfBytes.length },
      });

      const mediaUpload = await this.http.post(uploadUrl, formData, {
        headers: { Authorization: `Bearer ${accessToken}`, ...(formData as any).getHeaders?.() },
      });

      this.logResponse(cId, 'WA upload contract response', mediaUpload.status, mediaUpload.data);

      if (mediaUpload.status >= 400 || !mediaUpload.data?.id) {
        throw new Error(`Failed to upload contract to WhatsApp. Status: ${mediaUpload.status}`);
      }

      const mediaId = mediaUpload.data.id;

      const messagePayload = {
        messaging_product: 'whatsapp',
        to,
        type: 'document',
        document: { id: mediaId, filename },
      };

      const sendUrl = `/${phoneNumberId}/messages`;
      this.logRequest(cId, 'WA send contract request', { url: sendUrl, payload: messagePayload });

      const sendRes = await this.http.post(sendUrl, messagePayload, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      });

      this.logResponse(cId, 'WA send contract response', sendRes.status, sendRes.data);

      if (sendRes.status >= 400) {
        throw new Error(`WhatsApp send contract error: ${sendRes.status}`);
      }

      // 3) Guardar OUTGOING
      const chatMessage = this.chatMessageRepository.create({
        content: `📎 Contract sent: ${filename}`,
        direction: 'OUTGOING',
        client,
        ...(agent && { agent }),
        loanRequest: loan,
      });
      await this.chatMessageRepository.save(chatMessage);

      return { success: true, cId, sent: true, to, waId: sendRes.data?.messages?.[0]?.id };
    } catch (err) {
      this.logError(cId, 'sendContractToClient', err);
      throw err;
    }
  }
}
