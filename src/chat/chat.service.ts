import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, In, Not, Repository } from 'typeorm';

import { Client, ClientStatus } from '../entities/client.entity';
import { User } from '../entities/user.entity';
import { LoanRequest, LoanRequestStatus } from '../entities/loan-request.entity';
import { Document } from '../entities/document.entity';
import { ChatMessage } from '../entities/chat-message.entity';
import { Branch } from '../entities/branch.entity';

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { join, dirname } from 'path';
import { v4 as uuid } from 'uuid';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as FormData from 'form-data';
import { Readable } from 'stream';
import { Notification } from 'src/notifications/notifications.entity';
import { ConfigService } from '@nestjs/config';

type Dict = Record<string, any>;

@Injectable()
export class ChatService implements OnModuleInit {
  private readonly logger = new Logger(ChatService.name);
  private http: AxiosInstance;

  constructor(
    @InjectRepository(Client) private clientRepository: Repository<Client>,
    @InjectRepository(User) private userRepository: Repository<User>,
    @InjectRepository(Document) private documentRepository: Repository<Document>,
    @InjectRepository(LoanRequest) private loanRequestRepository: Repository<LoanRequest>,
    @InjectRepository(ChatMessage) private chatMessageRepository: Repository<ChatMessage>,
    @InjectRepository(Notification) private notificationRepository: Repository<Notification>,
    @InjectRepository(Branch) private branchRepository: Repository<Branch>,         // 👈 Branch
    private readonly config: ConfigService,
  ) {
    this.http = axios.create({
      baseURL: `https://graph.facebook.com/${this.getGraphVersion()}`,
      timeout: 30000,
      validateStatus: () => true,
    });
  }

  /* ================= Boot check ================= */
  onModuleInit() {
    console.log('[BOOT] GRAPH_API_VERSION:', this.getGraphVersion());
    console.log('[BOOT] WHATSAPP_PHONE_NUMBER_ID:', this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID') || '(NO DEFINIDO)');
    console.log('[BOOT] WHATSAPP_TOKEN set?:', !!this.config.get<string>('WHATSAPP_TOKEN'));
    console.log('[BOOT] DEBUG_WA:', this.DEBUG_WA);
  }

  /* ================= Helpers ================= */
  private getGraphVersion(): string {
    return this.config.get<string>('GRAPH_API_VERSION') || 'v21.0';
  }
  private getAccessToken(): string {
    const t = this.config.get<string>('WHATSAPP_TOKEN');
    if (!t) throw new Error('Config faltante: WHATSAPP_TOKEN no está definido.');
    return t;
  }
  private getPhoneNumberId(): string {
    const id = this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    if (!id || /^0+$/.test(id)) {
      throw new Error('Config faltante: WHATSAPP_PHONE_NUMBER_ID no está definido o es inválido.');
    }
    return id;
  }
  private get DEBUG_WA(): boolean {
    return (this.config.get<string>('DEBUG_WA') || '').toLowerCase() === 'true';
  }
  private ensureDir(path: string) {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
  }

  // Normaliza a E.164 con país por defecto (solo para envíos salientes)
  private toE164(phone: string): string {
    const raw = (phone || '').trim();
    const digits = raw.replace(/[^\d+]/g, '');
    if (raw.startsWith('+')) return raw;
    if (raw.startsWith('00')) return `+${raw.replace(/\D/g, '').slice(2)}`;

    const def = (this.config.get<string>('DEFAULT_COUNTRY_CODE') || '57').replace(/\D/g, '') || '57';
    const justDigits = raw.replace(/\D/g, '');

    // CO: celulares 10 dígitos que empiezan en 3
    if (justDigits.length === 10 && justDigits.startsWith('3')) return `+${def}${justDigits}`;
    if (justDigits.length >= 11) return `+${justDigits}`;
    return `+${def}${justDigits}`;
  }

  private redactBearer(v?: string) {
    if (!v) return v;
    return v.replace(/(Bearer\s+)[A-Za-z0-9\-\._]+/i, '$1***REDACTED***');
  }
  private maskPhone(p?: string) {
    if (!p) return p;
    const d = p.replace(/\D/g, '');
    if (d.length <= 4) return '***';
    return `${d.slice(0, 3)}***${d.slice(-2)}`;
  }
  private sizeOf(data: any): number {
    try {
      if (Buffer.isBuffer(data)) return data.length;
      if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
      return Buffer.byteLength(JSON.stringify(data || {}), 'utf8');
    } catch { return 0; }
  }

  private debug(label: string, obj?: Dict) {
    if (this.DEBUG_WA) console.debug(`[DEBUG_WA] ${label}:`, obj ?? {});
    this.logger.debug(JSON.stringify({ label, ...(obj || {}) }, null, 2));
  }
  private info(label: string, obj?: Dict) {
    if (this.DEBUG_WA) console.log(`[DEBUG_WA] ${label}:`, obj ?? {});
    this.logger.log(JSON.stringify({ label, ...(obj || {}) }, null, 2));
  }
  private warn(label: string, obj?: Dict) {
    if (this.DEBUG_WA) console.warn(`[DEBUG_WA] ${label}:`, obj ?? {});
    this.logger.warn(JSON.stringify({ label, ...(obj || {}) }, null, 2));
  }
  private error(label: string, obj?: Dict) {
    if (this.DEBUG_WA) console.error(`[DEBUG_WA] ${label}:`, obj ?? {});
    this.logger.error(JSON.stringify({ label, ...(obj || {}) }, null, 2));
  }
  private extractMetaError(res: AxiosResponse | undefined) {
    if (!res) return null;
    const e = (res.data as any)?.error;
    if (!e) return null;
    return {
      code: e.code,
      type: e.type,
      message: e.message,
      error_subcode: e.error_subcode,
      fbtrace_id: e.fbtrace_id,
      details: e.error_data || e.details,
    };
  }

  /* ========== País/branch helpers ========== */

  /** Devuelve las branches habilitadas para entrantes, ordenadas por longitud del phoneCountryCode (desc). */
  private async getInboundBranches(): Promise<Branch[]> {
    const branches = await this.branchRepository.find({
      where: { acceptsInbound: true },
      relations: { administrator: false, agents: false },
      order: { id: 'ASC' },
    });
    // Ordenar por longitud de prefijo para evitar colisiones (p.ej. 1 vs 57)
    return branches.sort((a, b) => (b.phoneCountryCode?.length || 0) - (a.phoneCountryCode?.length || 0));
  }

  /** Encuentra la branch que coincide por prefijo de phoneCountryCode con el número WA (sin '+'). */
  private async resolveBranchForIncoming(waFromRaw: string): Promise<Branch | null> {
    const digits = (waFromRaw || '').replace(/\D/g, ''); // '573165...'
    if (!digits) return null;

    const branches = await this.getInboundBranches();
    for (const b of branches) {
      const cc = (b.phoneCountryCode || '').replace(/\D/g, '');
      if (!cc) continue;
      if (digits.startsWith(cc)) {
        return b;
      }
    }
    return null;
  }

  /** Selecciona el agente menos cargado de una branch (por solicitudes abiertas) */
  private async pickLeastBusyAgentInBranch(branchId: number): Promise<User | null> {
    // Devuelve filas { user_id, activeCount }
    const rows = await this.userRepository
      .createQueryBuilder('user')
      .leftJoin('user.loanRequests', 'loan',
        'loan.status NOT IN (:...closed)', { closed: [LoanRequestStatus.COMPLETED, LoanRequestStatus.REJECTED] })
      .leftJoin('user.branch', 'branch')
      .where('user.role = :role', { role: 'AGENT' })
      .andWhere('branch.id = :branchId', { branchId })
      .select(['user.id'])
      .addSelect('COUNT(loan.id)', 'activeCount')
      .groupBy('user.id')
      .orderBy('activeCount', 'ASC')
      .addOrderBy('user.id', 'ASC')
      .getRawMany<{ user_id: number; activeCount: string }>();

    if (!rows.length) return null;
    const agentId = rows[0].user_id;
    const agent = await this.userRepository.findOne({ where: { id: agentId }, relations: { branch: true } });
    return agent ?? null;
  }

  /* ================= Media: descarga y guardado ================= */
  async downloadAndStoreMedia(mediaId: string, mimeType: string): Promise<string> {
    const cId = uuid();
    const token = this.getAccessToken();

    try {
      // 1) Metadata
      const metaUrl = `/${mediaId}`;
      const t0 = Date.now();
      this.debug('WA.media.meta.request', {
        cId, url: this.http.defaults.baseURL + metaUrl,
        headers: { Authorization: this.redactBearer(`Bearer ${token}`) },
      });

      const metadata = await this.http.get(metaUrl, { headers: { Authorization: `Bearer ${token}` } });

      this.debug('WA.media.meta.response', {
        cId, status: metadata.status, ms: Date.now() - t0,
        data: metadata.data,
        fb_headers: { 'x-fb-trace-id': metadata.headers['x-fb-trace-id'], 'x-fb-rev': metadata.headers['x-fb-rev'] },
      });

      if (metadata.status >= 400) throw new Error(`Media metadata error: ${metadata.status}`);
      const fileUrl = metadata.data?.url as string;
      if (!fileUrl) throw new Error('Media URL missing');

      // 2) Binario
      const t1 = Date.now();
      this.debug('WA.media.file.request', { cId, fileUrl });

      const file = await axios.get(fileUrl, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'arraybuffer',
        timeout: 30000,
        validateStatus: () => true,
      });

      this.debug('WA.media.file.response', {
        cId, status: file.status, ms: Date.now() - t1, size: (file.data as Buffer)?.length,
      });

      if (file.status >= 400) throw new Error(`Media download error: ${file.status}`);

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

      this.info('WA.media.stored', { cId, relativePath, mimeType, size: (file.data as Buffer).length });
      return relativePath;
    } catch (err: any) {
      this.error('WA.media.error', { cId, msg: err?.message });
      throw err;
    }
  }

  /* ================= Webhook entrante ================= */
  async processIncoming(payload: any) {
    const cId = uuid();
    try {
      this.debug('INCOMING.received', { cId, payload });

      const value = payload?.entry?.[0]?.changes?.[0]?.value;
      const messageData = value?.messages?.[0];
      const statuses = value?.statuses?.[0];

      // 1) Si llega un status solamente, log y salir
      if (statuses && !messageData) {
        this.debug('INCOMING.status', { cId, statuses });
        return;
      }
      // Si llegan ambos, igual registramos el status
      if (statuses && messageData) {
        this.debug('INCOMING.status', { cId, statuses });
      }

      const phoneFrom = messageData?.from; // WA id, ej: "57316..."
      const type = messageData?.type;

      if (!phoneFrom) {
        if (messageData) this.warn('INCOMING.missingPhone', { cId });
        return;
      }

      // 2) Validar país/branch ANTES de crear nada
      const branch = await this.resolveBranchForIncoming(phoneFrom);
      if (!branch) {
        this.warn('INCOMING.rejected.unknown_country_or_blocked', { cId, phone: this.maskPhone(phoneFrom) });
        return; // ⬅️ Política: NO crear client / loan / chat si no hay branch inbound
      }

      // 3) Cliente (crear solo ahora, ya que tenemos branch válida)
      let client = await this.clientRepository.findOne({
        where: { phone: phoneFrom },
        relations: ['loanRequests', 'loanRequests.agent'],
      });
      if (!client) {
        client = this.clientRepository.create({
          phone: phoneFrom,                                // guardamos como llega de WA (sin '+')
          name: `Client ${phoneFrom}`,
          status: ClientStatus.PROSPECT,
        });
        await this.clientRepository.save(client);
        this.debug('INCOMING.client.created', { cId, clientId: client.id, phone: this.maskPhone(phoneFrom), branchId: branch.id });
      }

      const isText = type === 'text';
      const isImage = type === 'image';
      const isDocument = type === 'document';

      // 4) Buscar solicitud abierta y agente
      let loanRequest =
        client.loanRequests?.find(
          (lr) => lr.status !== LoanRequestStatus.COMPLETED && lr.status !== LoanRequestStatus.REJECTED,
        ) || null;
      let assignedAgent: User | null = loanRequest?.agent ?? null;

      // Si no hay solicitud abierta, intentamos asignar agente SOLO de la branch
      if (!loanRequest) {
        assignedAgent = await this.pickLeastBusyAgentInBranch(branch.id);
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
              description: `Se te ha asignado una nueva solicitud, contacta al cliente ${client.name} (${client.phone}).`,
            }),
          );

          this.debug('INCOMING.loan.created', { cId, loanRequestId: loanRequest.id, agentId: assignedAgent.id, branchId: branch.id });
        } else {
          this.warn('INCOMING.noAgentInBranch', { cId, branchId: branch.id });
        }
      }

      // 5) Contenido del mensaje
      let content = '';
      if (isText) {
        content = messageData.text.body;
      } else if (isImage || isDocument) {
        const media = isImage ? messageData.image : messageData.document;
        const mimeType = media.mime_type;
        const mediaId = media.id;

        const url = await this.downloadAndStoreMedia(mediaId, mimeType);

        // Vincular el documento al loan abierto si existe
        const doc = await this.documentRepository.save({
          type: mimeType,
          url,
          client,
          loanRequest: loanRequest || undefined,
          createdAt: new Date(),
        });

        this.debug('INCOMING.document.persisted', { cId, documentId: doc.id, url, mimeType });
        content = `📎 Documento recibido: [Ver archivo](/documents/view/${doc.id})`;
      } else {
        this.warn('INCOMING.unsupportedType', { cId, type });
        return;
      }

      // 6) Guardar chat message
      // - Si hay agente, lo vinculamos a agente + loan (si existe).
      // - Si no hay agente en la branch, guardamos el mensaje sin agente/loan para no perder el contexto.
      const msgData: DeepPartial<ChatMessage> = {
        content,
        direction: 'INCOMING',
        client,
        ...(assignedAgent ? { agent: assignedAgent } : {}),
        ...(loanRequest ? { loanRequest } : {}),
      };
      const chatMessage = this.chatMessageRepository.create(msgData);
      await this.chatMessageRepository.save(chatMessage);

      this.info('INCOMING.saved', {
        cId,
        phone: this.maskPhone(phoneFrom),
        type,
        branchId: branch.id,
        withAgent: !!assignedAgent,
        withLoan: !!loanRequest,
      });
    } catch (error: any) {
      this.error('INCOMING.error', { cId, msg: error?.message });
    }
  }

  /* ================= Enviar texto ================= */
  async sendMessageToClient(clientId: number, message: string) {
    const cId = uuid();

    const client = await this.clientRepository.findOne({ where: { id: clientId } });
    if (!client || !client.phone) throw new NotFoundException('Client not found or missing phone number.');
    const to = this.toE164(client.phone);

    const loanRequest = await this.loanRequestRepository.findOne({
      where: { client: { id: client.id } },
      relations: ['agent'],
      order: { createdAt: 'DESC' },
    });
    const agent = loanRequest?.agent;

    const accessToken = this.getAccessToken();
    const phoneNumberId = this.getPhoneNumberId();

    const payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body: message } };

    try {
      const t0 = Date.now();
      this.debug('OUT.text.request', {
        cId, url: this.http.defaults.baseURL + `/${phoneNumberId}/messages`,
        headers: { Authorization: this.redactBearer(`Bearer ${accessToken}`), 'Content-Type': 'application/json' },
        payload,
      });

      const res = await this.http.post(`/${phoneNumberId}/messages`, payload, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      });

      const ms = Date.now() - t0;
      const errorInfo = this.extractMetaError(res);

      this.debug('OUT.text.response', {
        cId, status: res.status, ms, size: this.sizeOf(res.data),
        data: res.data,
        fb_headers: { 'x-fb-trace-id': res.headers['x-fb-trace-id'], 'x-fb-rev': res.headers['x-fb-rev'] },
      });

      if (res.status >= 400 || errorInfo) {
        this.error('OUT.text.failed', { cId, status: res.status, errorInfo });
        throw new Error(`WhatsApp API error: ${res.status} ${errorInfo ? JSON.stringify(errorInfo) : ''}`);
      }

      const msgData: DeepPartial<ChatMessage> = {
        content: message,
        direction: 'OUTGOING',
        client,
        ...(agent && { agent }),
        ...(loanRequest && { loanRequest }),
      };
      const chatMessage = this.chatMessageRepository.create(msgData);
      await this.chatMessageRepository.save(chatMessage);

      this.info('OUT.text.sent', { cId, to: this.maskPhone(to), waId: res.data?.messages?.[0]?.id });
      return { success: true, cId, to, message, waId: res.data?.messages?.[0]?.id };
    } catch (err: any) {
      this.error('OUT.text.error', { cId, msg: err?.message });
      throw err;
    }
  }

  /* ================= Conversaciones por agente ================= */
  async getAgentConversations(agentId: number) {
    const messages = await this.chatMessageRepository.find({
      where: { agent: { id: agentId } },
      relations: ['client'],
      order: { createdAt: 'DESC' },
    });

    const grouped = new Map<number, { client: Client; messages: ChatMessage[] }>();
    for (const msg of messages) {
      if (!msg.client) continue;
      const cid = msg.client.id;
      if (!grouped.has(cid)) grouped.set(cid, { client: msg.client, messages: [] });
      grouped.get(cid)!.messages.push(msg);
    }
    return Array.from(grouped.values());
  }

  /* ================= Enviar simulación (media) ================= */
  async sendSimulationToClient(clientId: number, file: Express.Multer.File) {
    const cId = uuid();

    const client = await this.clientRepository.findOne({ where: { id: clientId } });
    if (!client || !client.phone) throw new NotFoundException('Client not found or missing phone number.');
    const to = this.toE164(client.phone);

    const loanRequest = await this.loanRequestRepository.findOne({
      where: { client: { id: client.id } },
      relations: ['agent'],
      order: { createdAt: 'DESC' },
    });
    const agent = loanRequest?.agent;

    const accessToken = this.getAccessToken();
    const phoneNumberId = this.getPhoneNumberId();

    const bufferStream = new Readable();
    bufferStream.push(file.buffer);
    bufferStream.push(null);

    try {
      // 1) Upload
      const formData = new (FormData as any)();
      formData.append('file', bufferStream, { filename: file.originalname, contentType: file.mimetype });
      formData.append('messaging_product', 'whatsapp');
      formData.append('type', file.mimetype);

      const upStart = Date.now();
      this.debug('OUT.media.upload.request', {
        cId, url: this.http.defaults.baseURL + `/${phoneNumberId}/media`,
        headers: { Authorization: this.redactBearer(`Bearer ${accessToken}`), ...(formData as any).getHeaders?.() },
        file: { name: file.originalname, mimetype: file.mimetype, size: file.size },
      });

      const mediaUpload = await this.http.post(`/${phoneNumberId}/media`, formData, {
        headers: { Authorization: `Bearer ${accessToken}`, ...(formData as any).getHeaders?.() },
      });

      this.debug('OUT.media.upload.response', { cId, status: mediaUpload.status, ms: Date.now() - upStart, data: mediaUpload.data });

      if (mediaUpload.status >= 400 || !mediaUpload.data?.id) {
        this.error('OUT.media.upload.failed', { cId, status: mediaUpload.status, data: mediaUpload.data });
        throw new Error(`Failed to upload media. Status: ${mediaUpload.status}`);
      }

      const mediaId = mediaUpload.data.id;
      const isImage = file.mimetype.startsWith('image/');
      const type = isImage ? 'image' : 'document';
      const mediaPayload: any = {
        messaging_product: 'whatsapp',
        to,
        type,
        [type]: isImage ? { id: mediaId } : { id: mediaId, filename: file.originalname },
      };

      // 2) Send
      const sendStart = Date.now();
      this.debug('OUT.media.send.request', {
        cId, url: this.http.defaults.baseURL + `/${phoneNumberId}/messages`,
        headers: { Authorization: this.redactBearer(`Bearer ${accessToken}`), 'Content-Type': 'application/json' },
        payload: mediaPayload,
      });

      const sendRes = await this.http.post(`/${phoneNumberId}/messages`, mediaPayload, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      });

      const errorInfo = this.extractMetaError(sendRes);
      this.debug('OUT.media.send.response', {
        cId, status: sendRes.status, ms: Date.now() - sendStart, data: sendRes.data,
        fb_headers: { 'x-fb-trace-id': sendRes.headers['x-fb-trace-id'], 'x-fb-rev': sendRes.headers['x-fb-rev'] },
      });

      if (sendRes.status >= 400 || errorInfo) {
        this.error('OUT.media.send.failed', { cId, status: sendRes.status, errorInfo });
        throw new Error(`WhatsApp send media error: ${sendRes.status} ${errorInfo ? JSON.stringify(errorInfo) : ''}`);
      }

      // 3) Guardar mensaje
      const content = `📎 Simulation sent: ${file.originalname}`;
      const chatMessage = this.chatMessageRepository.create({
        content,
        direction: 'OUTGOING',
        client,
        ...(agent && { agent }),
        ...(loanRequest && { loanRequest }),
      });
      await this.chatMessageRepository.save(chatMessage);

      this.info('OUT.media.sent', { cId, to: this.maskPhone(to), waId: sendRes.data?.messages?.[0]?.id });
      return { success: true, cId, to, file: file.originalname, waId: sendRes.data?.messages?.[0]?.id };
    } catch (err: any) {
      this.error('OUT.media.error', { cId, msg: err?.message });
      throw err;
    }
  }

  /* ================= Generar & enviar contrato (PDF) ================= */
  async sendContractToClient(loanRequestId: number) {
    const cId = uuid();

    const loan = await this.loanRequestRepository.findOne({
      where: { id: loanRequestId },
      relations: ['client', 'agent'],
    });
    if (!loan || !loan.client?.phone) throw new NotFoundException('Loan or client not found');

    const client = loan.client;
    const agent = loan.agent;
    loan.endDateAt = new Date(loan.endDateAt);

    const pdfDoc = await PDFDocument.create();
    const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const marginX = 55, columnW = 480, lineH = 16, bottomMargin = 60;
    let page = pdfDoc.addPage([595.28, 841.89]);
    let cursorY = 800;

    const addPage = () => { page = pdfDoc.addPage([595.28, 841.89]); cursorY = 800; };
    const ensureSpace = (n = lineH) => { if (cursorY - n < bottomMargin) addPage(); };
    const drawParagraph = (text: string, font = helv, size = 11, color = rgb(0, 0, 0), extra = 4) => {
      const words = text.replace(/\s+/g, ' ').trim().split(' ');
      let line = '';
      words.forEach((w, i) => {
        const test = line ? `${line} ${w}` : w;
        const width = font.widthOfTextAtSize(test, size);
        if (width > columnW) { ensureSpace(); page.drawText(line, { x: marginX, y: cursorY, size, font, color }); cursorY -= lineH; line = w; }
        else { line = test; }
        if (i === words.length - 1) { ensureSpace(); page.drawText(line, { x: marginX, y: cursorY, size, font, color }); cursorY -= lineH + extra; }
      });
    };

    ensureSpace(); page.drawText('CONTRATO DE CRÉDITO LIBRE INVERSIÓN', { x: marginX, y: cursorY, size: 14, font: helvBold }); cursorY -= lineH + 6;
    drawParagraph(`Partes... ${client.name} CC ${client.document} ...`);
    drawParagraph('Texto contractual resumido...');
    ensureSpace(); page.drawText('1. Objeto', { x: marginX, y: cursorY, size: 12, font: helvBold }); cursorY -= lineH;
    drawParagraph('El presente contrato tiene por objeto...');
    ensureSpace(); page.drawText(`Monto aprobado: $${loan.requestedAmount?.toFixed(2)}`, { x: marginX, y: cursorY, size: 11, font: helvBold }); cursorY -= lineH;
    ensureSpace(); page.drawText(`Monto total a pagar: $${loan.amount?.toFixed(2)}`, { x: marginX, y: cursorY, size: 11, font: helvBold }); cursorY -= lineH;
    ensureSpace(); page.drawText(`Fecha única de pago: ${new Date(loan.endDateAt).toISOString().split('T')[0]}`, { x: marginX, y: cursorY, size: 11, font: helvBold }); cursorY -= lineH + 6;
    drawParagraph('Cláusulas adicionales...');
    drawParagraph(`Nombre: ${client.name} | CC: ${client.document}`);

    const pdfBytes = await pdfDoc.save();
    const filename = `LoanContract-${loan.id}.pdf`;
    const filePath = join(__dirname, '..', '..', 'public', 'uploads', 'documents', filename);
    this.ensureDir(dirname(filePath));
    writeFileSync(filePath, pdfBytes);

    const accessToken = this.getAccessToken();
    const phoneNumberId = this.getPhoneNumberId();
    const to = this.toE164(client.phone);

    const bufferStream = new Readable();
    bufferStream.push(pdfBytes);
    bufferStream.push(null);

    try {
      // Upload
      const formData = new (FormData as any)();
      formData.append('file', bufferStream, { filename, contentType: 'application/pdf' });
      formData.append('messaging_product', 'whatsapp');
      formData.append('type', 'application/pdf');

      const upStart = Date.now();
      this.debug('OUT.contract.upload.request', {
        cId, url: this.http.defaults.baseURL + `/${phoneNumberId}/media`,
        headers: { Authorization: this.redactBearer(`Bearer ${accessToken}`), ...(formData as any).getHeaders?.() },
        file: { filename, size: pdfBytes.length },
      });

      const mediaUpload = await this.http.post(`/${phoneNumberId}/media`, formData, {
        headers: { Authorization: `Bearer ${accessToken}`, ...(formData as any).getHeaders?.() },
      });

      this.debug('OUT.contract.upload.response', { cId, status: mediaUpload.status, ms: Date.now() - upStart, data: mediaUpload.data });

      if (mediaUpload.status >= 400 || !mediaUpload.data?.id) {
        this.error('OUT.contract.upload.failed', { cId, status: mediaUpload.status, data: mediaUpload.data });
        throw new Error(`Failed to upload contract. Status: ${mediaUpload.status}`);
      }

      const mediaId = mediaUpload.data.id;
      const messagePayload = {
        messaging_product: 'whatsapp',
        to,
        type: 'document',
        document: { id: mediaId, filename },
      };

      // Send
      const sendStart = Date.now();
      this.debug('OUT.contract.send.request', {
        cId, url: this.http.defaults.baseURL + `/${phoneNumberId}/messages`,
        headers: { Authorization: this.redactBearer(`Bearer ${accessToken}`), 'Content-Type': 'application/json' },
        payload: messagePayload,
      });

      const sendRes = await this.http.post(`/${phoneNumberId}/messages`, messagePayload, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      });

      const errorInfo = this.extractMetaError(sendRes);
      this.debug('OUT.contract.send.response', {
        cId, status: sendRes.status, ms: Date.now() - sendStart, data: sendRes.data,
        fb_headers: { 'x-fb-trace-id': sendRes.headers['x-fb-trace-id'], 'x-fb-rev': sendRes.headers['x-fb-rev'] },
      });

      if (sendRes.status >= 400 || errorInfo) {
        this.error('OUT.contract.send.failed', { cId, status: sendRes.status, errorInfo });
        throw new Error(`WhatsApp send contract error: ${sendRes.status} ${errorInfo ? JSON.stringify(errorInfo) : ''}`);
      }

      const chatMessage = this.chatMessageRepository.create({
        content: `📎 Contract sent: ${filename}`,
        direction: 'OUTGOING',
        client,
        ...(agent && { agent }),
        loanRequest: loan,
      });
      await this.chatMessageRepository.save(chatMessage);

      this.info('OUT.contract.sent', { cId, to: this.maskPhone(to), waId: sendRes.data?.messages?.[0]?.id });
      return { success: true, cId, sent: true, to, waId: sendRes.data?.messages?.[0]?.id };
    } catch (err: any) {
      this.error('OUT.contract.error', { cId, msg: err?.message });
      throw err;
    }
  }
}
