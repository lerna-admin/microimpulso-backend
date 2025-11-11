import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, In, Not, Repository } from 'typeorm';

import { Client, ClientStatus } from '../entities/client.entity';
import { User, UserRole } from '../entities/user.entity';
import { LoanRequest, LoanRequestStatus } from '../entities/loan-request.entity';
import { Document } from '../entities/document.entity';
import { ChatMessage } from '../entities/chat-message.entity';
import { Branch } from '../entities/branch.entity'; // 👈 solo para tipado/manager

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { join, dirname } from 'path';
import { v4 as uuid } from 'uuid';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import * as FormData from 'form-data';
import { Readable } from 'stream';
import { Notification } from 'src/notifications/notifications.entity';
import { ConfigService } from '@nestjs/config';
// Rellenar DOCX y convertir a PDF
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import * as libre from 'libreoffice-convert';

// FS y rutas


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
    private readonly config: ConfigService,
  ) {
    this.http = axios.create({
      baseURL: `https://graph.facebook.com/${this.getGraphVersion()}`,
      timeout: 30000,
      validateStatus: () => true, // loguear también 4xx/5xx
    });
  }
  
  /* ================= Boot check ================= */
  onModuleInit() {
    console.log('[BOOT] GRAPH_API_VERSION:', this.getGraphVersion());
    console.log('[BOOT] WHATSAPP_PHONE_NUMBER_ID:', this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID') || '(NO DEFINIDO)');
    console.log('[BOOT] WHATSAPP_TOKEN set?:', !!this.config.get<string>('WHATSAPP_TOKEN'));
    console.log('[BOOT] DEBUG_WA:', this.DEBUG_WA);
  }
  
  /* ================= Helpers generales ================= */
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
  private toE164(phone: string): string {
    const t = (phone || '').trim();
    if (t.startsWith('+')) return t;
    if (t.startsWith('00')) return `+${t.replace(/\D/g, '').slice(2)}`;
    return `+${t.replace(/\D/g, '')}`;
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
  
  /* ========== País desde número & selección de branch/agent ========== */
  
  /** Extrae el indicativo internacional (sin '+') del número entrante. */
  private extractCountryCallingCode(phone: string): string | null {
    if (!phone) return null;
    const s = String(phone).trim();
    
    // +E.164: +57..., +506...
    if (s.startsWith('+')) {
      // priorizamos 3 dígitos si es 506 (CR)
      if (s.startsWith('+506')) return '506';
      const m = s.match(/^\+(\d{2,3})/);
      return m?.[1] ?? null;
    }
    // 00-prefijo internacional
    if (s.startsWith('00')) {
      const rest = s.replace(/\D/g, '').slice(2);
      if (rest.startsWith('506')) return '506';
      return rest.slice(0, 2);
    }
    // Solo dígitos u otros
    const digits = s.replace(/\D/g, '');
    if (!digits) return null;
    
    // Reglas conocidas
    if (digits.startsWith('506')) return '506'; // CR
    if (digits.startsWith('57')) return '57';   // CO
    
    // Caso CO local: 10 dígitos iniciando en 3 ⇒ asumimos 57
    if (digits.length === 10 && digits.startsWith('3')) return '57';
    
    // Fallback: primeros 3 o 2
    return digits.length >= 3 ? digits.slice(0, 3) : (digits.length >= 2 ? digits.slice(0, 2) : null);
  }
  
  /** Busca TODAS las sedes de un país (por phoneCountryCode) que acepten entrantes. */
  private async findInboundBranchesByCallingCode(code: string | null): Promise<Branch[]> {
    if (!code) return [];
    const branchRepo = this.userRepository.manager.getRepository(Branch);
    return branchRepo.find({ where: { phoneCountryCode: code, acceptsInbound: true } });
  }
  
  /** Elige el agente menos cargado entre TODAS las sedes del país. */
  private async pickLeastBusyAgentForCountry(callingCode: string): Promise<{ agent: User | null; branchId: number | null }> {
    const branchRepo = this.userRepository.manager.getRepository(Branch);
    const branches = await branchRepo.find({
      where: { phoneCountryCode: callingCode, acceptsInbound: true },
      select: ['id'],
    });
    if (!branches.length) return { agent: null, branchId: null };
    
    const branchIds = branches.map((b) => b.id);
    
    // Contar solicitudes activas por agente en esas sedes
    const raw = await this.userRepository
    .createQueryBuilder('u')
    .leftJoin('u.branch', 'b')
    .leftJoin('u.loanRequests', 'lr', "lr.status NOT IN ('COMPLETED','REJECTED')")
    .where('u.role = :role', { role: 'AGENT' })
    .andWhere('b.id IN (:...branchIds)', { branchIds })
    .select(['u.id', 'b.id'])
    .addSelect('COUNT(lr.id)', 'activeCount')
    .groupBy('u.id')
    .addGroupBy('b.id')
    .orderBy('activeCount', 'ASC')
    .getRawMany();
    
    if (!raw.length) return { agent: null, branchId: null };
    
    const agentId = raw[0].u_id ?? raw[0].user_id ?? raw[0].id;
    const branchId = raw[0].b_id ?? raw[0].branch_id ?? null;
    if (!agentId) return { agent: null, branchId: null };
    
    const agent = await this.userRepository.findOne({ where: { id: agentId } });
    return { agent: agent ?? null, branchId };
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
      
      // 2) Archivo
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
      
      if (statuses) this.debug('INCOMING.status', { cId, statuses });
      
      const phoneFrom = messageData?.from;
      const type = messageData?.type;
      if (!phoneFrom) { this.warn('INCOMING.missingPhone', { cId }); return; }
      
      const isText = type === 'text';
      const isImage = type === 'image';
      const isDocument = type === 'document';
      
      // === (1) País por phone → branches del país que aceptan entrantes
      const callingCode = this.extractCountryCallingCode(phoneFrom);
      const inboundBranches = await this.findInboundBranchesByCallingCode(callingCode);
      
      if (!inboundBranches.length) {
        this.warn('INCOMING.noBranchForCountry', { cId, callingCode, from: this.maskPhone(phoneFrom) });
        // Política: si no hay sedes aptas para ese país, no generamos entidades.
        return;
      }
      
      // === (2) Cliente (usando nombre del contacto si viene)
      const profileName = value?.contacts?.[0]?.profile?.name || undefined;
      let client = await this.clientRepository.findOne({
        where: { phone: phoneFrom },
        relations: ['loanRequests', 'loanRequests.agent'],
      });
      
      if (!client) {
        client = this.clientRepository.create({
          phone: phoneFrom,
          name: profileName ? String(profileName) : `Client ${phoneFrom}`,
          status: ClientStatus.PROSPECT,
        });
        await this.clientRepository.save(client);
        this.debug('INCOMING.client.created', {
          cId, clientId: client.id, phone: this.maskPhone(phoneFrom),
          branchId: inboundBranches[0]?.id,
        });
      }
      
      // === (3) LoanRequest y agente
      let loanRequest =
      client.loanRequests?.find(
        (lr) => lr.status !== LoanRequestStatus.COMPLETED && lr.status !== LoanRequestStatus.REJECTED,
      ) || null;
      
      // Buscar el agente menos cargado entre TODAS las sedes del país
      const { agent: countryAgent, branchId: chosenBranchId } =
      await this.pickLeastBusyAgentForCountry(callingCode!);
      
      let assignedAgent: User | null = loanRequest?.agent ?? null;
      if (!assignedAgent && countryAgent) {
        assignedAgent = countryAgent;
      }
      
      if (!loanRequest) {
        const lrData: DeepPartial<LoanRequest> = {
          client,
          status: LoanRequestStatus.NEW,
          amount: 0,
          ...(assignedAgent ? { agent: assignedAgent } : {}),
        };
        loanRequest = this.loanRequestRepository.create(lrData);
        await this.loanRequestRepository.save(loanRequest);
        
        if (assignedAgent) {
          await this.notificationRepository.save(
            this.notificationRepository.create({
              recipientId: assignedAgent.id,
              category: 'loan',
              type: 'loan.assigned',
              payload: { loanRequestId: loanRequest.id, clientId: client.id },
              description: `Se te ha asignado una nueva solicitud. Cliente: ${client.name} (${client.phone})`,
            }),
          );
        } else {
          this.warn('INCOMING.noAgentInAnyBranchForCountry', {
            cId, callingCode, branches: inboundBranches.map(b => b.id)
          });
        }
        
        this.debug('INCOMING.loan.created', {
          cId,
          loanRequestId: loanRequest.id,
          agentId: assignedAgent?.id ?? null,
          countryCallingCode: callingCode,
          chosenBranchId: chosenBranchId ?? inboundBranches[0]?.id ?? null,
        });
      } else if (!loanRequest.agent && assignedAgent) {
        await this.loanRequestRepository.update(loanRequest.id, { agent: assignedAgent });
        loanRequest = await this.loanRequestRepository.findOne({
          where: { id: loanRequest.id },
          relations: ['client', 'agent'],
        });
        await this.notificationRepository.save(
          this.notificationRepository.create({
            recipientId: assignedAgent.id,
            category: 'loan',
            type: 'loan.assigned',
            payload: { loanRequestId: loanRequest!.id, clientId: client.id },
            description: `Se te asignó una solicitud existente. Cliente: ${client.name} (${client.phone})`,
          }),
        );
        this.debug('INCOMING.loan.agent.assigned', {
          cId,
          loanRequestId: loanRequest?.id,
          agentId: assignedAgent.id,
          countryCallingCode: callingCode,
          chosenBranchId: chosenBranchId ?? inboundBranches[0]?.id ?? null,
        });
      }
      
      // === (4) Contenido del mensaje
      let content = '';
      if (isText) {
        content = messageData.text.body;
      } else if (isImage || isDocument) {
        const media = isImage ? messageData.image : messageData.document;
        const mimeType = media.mime_type;
        const mediaId  = media.id;
        
        const url = await this.downloadAndStoreMedia(mediaId, mimeType);
        
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
      
      // === (5) Guardar chat_message SIEMPRE (con o sin agente)
      try {
        const chatData: DeepPartial<ChatMessage> = {
          content,
          direction: 'INCOMING',
          client,
          ...(loanRequest ? { loanRequest } : {}),
          ...(assignedAgent ? { agent: assignedAgent } : {}),
        };
        const chatMessage = this.chatMessageRepository.create(chatData);
        await this.chatMessageRepository.save(chatMessage);
        
        this.debug('INCOMING.chat.persisted', {
          cId,
          chatMessageId: chatMessage.id,
          loanRequestId: loanRequest?.id ?? null,
          agentId: assignedAgent?.id ?? null,
        });
      } catch (e: any) {
        this.error('INCOMING.chat.persist.error', { cId, msg: e?.message });
      }
      
      this.info('INCOMING.saved', {
        cId,
        phone: this.maskPhone(phoneFrom),
        type,
        countryCallingCode: callingCode,
        branchesTried: inboundBranches.map(b => b.id),
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
  // ===== Helpers de negocio y util =====
  private monthsEs = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  
  private splitDate(d: Date) { return { dia: d.getDate(), mesTxt: this.monthsEs[d.getMonth()], anio: d.getFullYear() }; }
  private lastDayOfMonth(y: number, m0: number) { return new Date(y, m0 + 1, 0).getDate(); }
  
  // Fecha de pago = siguiente quincena (15 o último día)
  private nextQuincena(from: Date): Date {
    const y = from.getFullYear(), m = from.getMonth(), d = from.getDate();
    const last = this.lastDayOfMonth(y, m);
    if (d < 15) return new Date(y, m, 15);
    if (d >= 15 && d < last) return new Date(y, m, last);
    return new Date(y, m + 1, 15);
  }
  private diffDays(a: Date, b: Date) {
    const ms = 24*60*60*1000;
    const a0 = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
    const b0 = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
    return Math.max(0, Math.round((b0 - a0)/ms));
  }
  private money(n: number) { return (n ?? 0).toLocaleString('es-CO', { maximumFractionDigits: 0 }); }
  
  // 20% con aval incluido (configurable AVAL_FEE_PCT, p.ej. 0.12 = 12%)
  private calcPaymentBreakdown(principal: number) {
    const ANTICIPO_PCT = 0.20;
    const avalPctRaw = Number(this.config.get<string>('AVAL_FEE_PCT') ?? '0');
    const AVAL_PCT = Math.min(Math.max(avalPctRaw, 0), ANTICIPO_PCT); // clamp [0..0.20]
    const anticipoValor = Math.round(principal * ANTICIPO_PCT);
    const avalValor = Math.round(principal * AVAL_PCT);
    const servicioValor = Math.max(0, anticipoValor - avalValor);
    return { ANTICIPO_PCT, anticipoValor, AVAL_PCT, avalValor, servicioValor };
  }
  
  // Número → letras (es-CO) para COP (entero)
  /** Convierte enteros >= 0 a palabras en español (con acentos).
  *  Soporta hasta miles de millones (>= 0 y < 1e12).
  *  Ej: 120000 -> "ciento veinte mil"
  */
  private numberToSpanish(n: number): string {
    let value = Math.trunc(Math.max(0, Number.isFinite(n) ? n : 0));
    if (value === 0) return 'cero';
    
    const U = [
      '', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
      'diez', 'once', 'doce', 'trece', 'catorce', 'quince',
      'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve',
      'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro',
      'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'
    ];
    const T = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
    const C = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];
    
    const seccion999 = (x: number): string => {
      if (x === 0) return '';
      if (x === 100) return 'cien';
      
      const centenas = Math.floor(x / 100);
      const decenasUn = x % 100;
      const decenas = Math.floor(decenasUn / 10);
      const unidades = decenasUn % 10;
      
      const parts: string[] = [];
      if (centenas > 0) parts.push(C[centenas]);
      
      if (decenasUn > 0) {
        if (decenasUn < 30) {
          parts.push(U[decenasUn]);
        } else {
          const d = T[decenas];
          if (unidades === 0) {
            parts.push(d);
          } else {
            parts.push(`${d} y ${U[unidades]}`);
          }
        }
      }
      return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    };
    
    const parts: string[] = [];
    
    // miles de millones (1,000,000,000 .. 999,000,000,000)
    let milesDeMillones = Math.floor(value / 1_000_000_000);
    if (milesDeMillones > 0) {
      parts.push(milesDeMillones === 1 ? 'mil millones' : `${seccion999(milesDeMillones)} mil millones`);
      value %= 1_000_000_000;
    }
    
    // millones
    const millones = Math.floor(value / 1_000_000);
    if (millones > 0) {
      parts.push(millones === 1 ? 'un millón' : `${seccion999(millones)} millones`);
      value %= 1_000_000;
    }
    
    // miles
    const miles = Math.floor(value / 1000);
    if (miles > 0) {
      parts.push(miles === 1 ? 'mil' : `${seccion999(miles)} mil`);
      value %= 1000;
    }
    
    // resto (0..999)
    if (value > 0) {
      parts.push(seccion999(value));
    }
    
    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }
  
  
  private amountToWordsCOP(n: number): string {
    const entero = Math.trunc(Math.max(0, n || 0));
    return `${this.numberToSpanish(entero).toUpperCase()} DE PESOS M/CTE`;
  }
  
  // ===== DOCX render & PDF =====
  private getTemplatePath(): string {
    // 1) Permite sobrescribir por .env si quieres (ruta absoluta o relativa)
    const envPath = this.config.get<string>('CONTRACT_TEMPLATE_PATH');
    if (envPath && existsSync(envPath)) return envPath;
    
    // 2) Candidatos portables (dist -> src -> relativo al archivo)
    const candidates = [
      // runtime en build
      join(process.cwd(), 'dist', 'chat', 'assets', 'CONTRATO DE MUTUO.docx'),
      // desarrollo
      join(process.cwd(), 'src', 'chat', 'assets', 'CONTRATO DE MUTUO.docx'),
      // fallback relativo a este archivo
      join(__dirname, 'assets', 'CONTRATO DE MUTUO.docx'),
    ];
    
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    throw new Error(
      'No se encontró la plantilla DOCX. Asegúrate de tener "src/chat/assets/CONTRATO DE MUTUO.docx" ' +
      'y de copiar assets a dist en nest-cli.json, o define CONTRACT_TEMPLATE_PATH en .env.'
    );
  }
  
  private renderDocx(data: Record<string, any>): Buffer {
    const content = readFileSync(this.getTemplatePath());
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
    doc.setData(data); doc.render();
    return doc.getZip().generate({ type: 'nodebuffer' });
  }
  private async convertDocxToPdf(docxBuffer: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      libre.convert(docxBuffer, '.pdf', undefined, (err: any, out: Buffer) => err ? reject(err) : resolve(out));
    });
  }
  
  /* ================= Helpers NUEVOS/ACTUALIZADOS ================= */
  
  /** SOLO el número en letras (sin “DE PESOS M/CTE”) para no duplicar en el pagaré. 
  *  Requiere que ya tengas implementado this.numberToSpanish(n).
  */
  private amountToWordsNumberOnly(n: number): string {
    const entero = Math.trunc(Math.max(0, n || 0));
    return this.numberToSpanish(entero).toUpperCase();
  }
  
  /** Tasa diaria (decimal). Prioriza DEFAULT_INTEREST_DAILY_PCT; si no, deriva de DEFAULT_INTEREST_EA_PCT. 
  *  Ej: ED 0.063556%  => 0.00063556
  */
  private getDailyRate(): number {
    const edPct = Number(this.config.get<string>('DEFAULT_INTEREST_DAILY_PCT') ?? '');
    if (Number.isFinite(edPct) && edPct > 0) return edPct / 100;
    
    const eaPct = Number(this.config.get<string>('DEFAULT_INTEREST_EA_PCT') ?? '');
    if (Number.isFinite(eaPct) && eaPct > 0) {
      const ea = eaPct / 100;
      return Math.pow(1 + ea, 1 / 365) - 1; // ED = (1+EA)^(1/365)-1
    }
    return 0;
  }
  
  /** Busca el usuario AVAL a usar en el contrato.
  *  Regla: 1) AVAL de la MISMA SEDE del agente si existe; 2) cualquier AVAL.
  */
  private async findAvalUserForLoan(agent?: User): Promise<User | null> {
    // 1) por sede del agente
    if (agent?.branch?.id) {
      const avalSameBranch = await this.userRepository.findOne({
        where: { role: UserRole.AVAL, branch: { id: agent.branch.id } },
        relations: ['branch'],
        order: { id: 'ASC' },
      });
      if (avalSameBranch) return avalSameBranch;
    }
    
    // 2) fallback: cualquier AVAL
    const anyAval = await this.userRepository.findOne({
      where: { role: UserRole.AVAL },
      relations: ['branch'],
      order: { id: 'ASC' },
    });
    return anyAval ?? null;
  }

  /** Tasa mensual efectiva (decimal).
 *  Prioriza ED: (1+ED)^(30)-1. Si no hay ED, usa EA: (1+EA)^(1/12)-1.
 */
private getMonthlyRate(): number {
  // 1) Si hay ED explícita (DEFAULT_INTEREST_DAILY_PCT o derivada), úsala
  const ed = this.getDailyRate(); // decimal
  if (ed > 0) return Math.pow(1 + ed, 30) - 1;

  // 2) Si no hay ED, intenta con EA
  const eaPct = Number(this.config.get<string>('DEFAULT_INTEREST_EA_PCT') ?? '');
  if (Number.isFinite(eaPct) && eaPct > 0) {
    const ea = eaPct / 100;
    return Math.pow(1 + ea, 1 / 12) - 1;
  }
  return 0;
}

/** Formatea un decimal (0.034) como "3.40%" con n decimales. */
private fmtPct(dec: number, digits = 2): string {
  if (!Number.isFinite(dec) || dec <= 0) return '';
  return `${(dec * 100).toFixed(digits)}%`;
}

  
  /* ================= FUNCIÓN ACTUALIZADA ================= */
  
  async sendContractToClient(loanRequestId: number) {
    const cId = uuid();
    
    // 1) Cargar Loan + Client + Agent (+branch del agente para ubicar aval)
    const loan = await this.loanRequestRepository.findOne({
      where: { id: loanRequestId },
      relations: ['client', 'agent', 'agent.branch'], // 👈 importante
    });
    if (!loan || !loan.client?.phone) throw new NotFoundException('Loan or client not found');
    
    const client = loan.client;
    const agent  = loan.agent;
    
    // 🔎 Buscar AVAL según regla (misma sede si es posible)
    const avalUser = await this.findAvalUserForLoan(agent);
    
    // Validación: ciudad requerida por plantilla
    if (!client.city?.trim()) {
      throw new Error('Falta la ciudad del cliente (client.city). Complétala antes de enviar el contrato.');
    }
    
    // 2) Cálculos de negocio
    const today = new Date();                 // fecha de firma
    const dueDate = this.nextQuincena(today); // próxima quincentodaya (15 o último día)
    
    const diasParaPago = this.diffDays(today, loan.endDateAt);
    
    // Capital (principal)
    const principal = typeof loan.amount === 'number'
    ? loan.amount
    : Number((loan as any).amount ?? loan.requestedAmount ?? 0);
    
    // === Política financiera ===
    // Total a pagar SIEMPRE = principal * 1.20
    const ANTICIPO_PCT = 0.20;
    const anticipoTotal = Math.round(principal * ANTICIPO_PCT); // 20% fijo
    
    // Aval: % fijo global sobre el principal (ENV: AVAL_FEE_PCT) y no puede superar el 20%
    const avalPctRaw = Number(this.config.get<string>('AVAL_FEE_PCT') ?? '0');
    const AVAL_PCT = Math.max(0, Math.min(avalPctRaw, ANTICIPO_PCT));
    const avalValor = Math.round(principal * AVAL_PCT);
    
    // Interés diario prorrateado y CAPEADO para respetar el 20% total
    const dailyRate = this.getDailyRate(); // decimal (ej: 0.00063556)
    const interesCalc = Math.round(principal * dailyRate * diasParaPago);
    const interesMax = Math.max(0, anticipoTotal - avalValor);
    const interes = Math.min(interesCalc, interesMax);
    
    // Servicio: cierre exacto del 20%
    const servicioValor = Math.max(0, anticipoTotal - avalValor - interes);
    
    // Total a pagar (política fija)
    const totalAPagar = Math.max(0, Math.round(principal + anticipoTotal));
    
    // En letras SOLO el número (para evitar duplicar “DE PESOS M/CTE” en el pagaré)
    const deudaEnLetrasSoloNumero = this.amountToWordsNumberOnly(totalAPagar);
    
    const { dia, mesTxt, anio } = this.splitDate(today);
    
    // Día en letras (1..31) respaldo simple
    const dayToWords: Record<number,string> = {
      1:'uno',2:'dos',3:'tres',4:'cuatro',5:'cinco',6:'seis',7:'siete',8:'ocho',9:'nueve',10:'diez',
      11:'once',12:'doce',13:'trece',14:'catorce',15:'quince',16:'dieciséis',17:'diecisiete',18:'dieciocho',19:'diecinueve',20:'veinte',
      21:'veintiuno',22:'veintidós',23:'veintitrés',24:'veinticuatro',25:'veinticinco',26:'veintiséis',27:'veintisiete',28:'veintiocho',29:'veintinueve',30:'treinta',31:'treinta y uno'
    };
    const diaEnLetras = dayToWords[dia] ?? this.numberToSpanish(dia);
    const diasParaPagoEnLetras = dayToWords[diasParaPago] ?? this.numberToSpanish(diasParaPago);

    // Tasas

    const monthlyRate = this.getMonthlyRate();          // decimal
    const tasaMensualPctStr = this.fmtPct(monthlyRate); // "3.00%" por ejemplo

    
    // 3) Tags para la plantilla DOCX
    // Nota: mantenemos las claves AGENTE_* para no tocar la plantilla; metemos ahí los datos del AVAL.
    // justo antes del try { ... } dentro de sendContractToClient:
    const dataForDocx: Record<string, any> = {
      // Deudor
      DEUDOR_NOMBRE: client.name || '',
      DEUDOR_CC: client.document || '',
      DEUDOR_DIRECCION: (client.address || client.address2 || '').trim(),
      DEUDOR_CIUDAD: client.city || '',
      DEUDOR_CIUDAD_UPPER: (client.city || '').toUpperCase(),  // <-- NUEVO
      
      // Capital (para cláusula SEGUNDO del contrato)
      CAPITAL_VALOR: this.money(principal),                     // <-- NUEVO
      CAPITAL_EN_LETRAS: this.amountToWordsNumberOnly(principal), // <-- NUEVO
      
      // Total a pagar (para pagaré y donde corresponda)
      DEUDA_NUMEROS: this.amountToWordsNumberOnly(totalAPagar),  // solo número en letras
      DEUDA_VALOR: this.money(totalAPagar),
      
      // Desglose anticipo (20% = aval + interés + servicio)
      PORCENTAJE_ANTICIPO: `${Math.round(ANTICIPO_PCT*100)}%`,
      ANTICIPO_VALOR: this.money(anticipoTotal),
      AVAL_PCT: `${Math.round(AVAL_PCT*100)}%`,
      AVAL_VALOR: this.money(avalValor),
      INTERES_VALOR: this.money(interes),
      SERVICIO_VALOR: this.money(servicioValor),
      
      // Plazo
      DIAS_PARA_PAGO: String(diasParaPago),
      DIAS_PARA_PAGO_TEXTO: `${diasParaPago} (${diasParaPagoEnLetras}) días`,
      
      // Fecha
      FECHA_DIA: String(dia), // sin cero a la izquierda
      FECHA_MES: mesTxt,
      FECHA_ANIO: String(anio),
      FECHA_DIA_LETRA: diaEnLetras,
      FECHA_DIA_LETRAS: diaEnLetras,
      
      // Datos del AVAL (la plantilla los llama AGENTE_*)
      AGENTE_NOMBRE: avalUser?.name || agent?.name || '',
      AGENTE_CC: (avalUser as any)?.document || (agent as any)?.document || '',
      
      // (opcionales)
      TASA_DIARIA_PCT: dailyRate ? `${(dailyRate*100).toFixed(6)}%` : '',
      TASA_EA_PCT: this.config.get<string>('DEFAULT_INTEREST_EA_PCT') || '',
      TASA_MENSUAL_PCT: tasaMensualPctStr,   
    };
    
    
    try {
      // LOG de verificación rápida
      this.debug('DOCX.data.preview', { cId, subset: {
        DEUDOR_NOMBRE: dataForDocx.DEUDOR_NOMBRE,
        DEUDOR_CC: dataForDocx.DEUDOR_CC,
        DEUDOR_CIUDAD: dataForDocx.DEUDOR_CIUDAD,
        DEUDA_VALOR: dataForDocx.DEUDA_VALOR,
        DIAS_PARA_PAGO_TEXTO: dataForDocx.DIAS_PARA_PAGO_TEXTO,
        AVAL_VALOR: dataForDocx.AVAL_VALOR,
        INTERES_VALOR: dataForDocx.INTERES_VALOR,
        SERVICIO_VALOR: dataForDocx.SERVICIO_VALOR,
        AGENTE_NOMBRE: dataForDocx.AGENTE_NOMBRE,
      }});
      
      // 4) Render DOCX (11 páginas) → PDF (1:1)
      this.debug('DOCX.render.start', { cId });
      const docxBuffer = this.renderDocx(dataForDocx); // usa getTemplatePath() ⇒ 'CONTRATO DE MUTUO.docx'
      this.debug('DOCX.render.ok', { cId, size: docxBuffer.length });
      
      this.debug('PDF.convert.start', { cId });
      const pdfBytes = await this.convertDocxToPdf(docxBuffer);
      this.debug('PDF.convert.ok', { cId, size: pdfBytes.length });
      
      // 5) Guardar PDF
      const filename = `ContratoMutuo-${loan.id}.pdf`;
      const filePath = join(__dirname, '..', '..', 'public', 'uploads', 'documents', filename);
      this.ensureDir(dirname(filePath));
      writeFileSync(filePath, pdfBytes);
      
      // 6) Subir a WhatsApp y enviar
      const accessToken = this.getAccessToken();
      const phoneNumberId = this.getPhoneNumberId();
      const to = this.toE164(client.phone);
      
      const bufferStream = new Readable();
      bufferStream.push(pdfBytes); bufferStream.push(null);
      
      const formData = new (FormData as any)();
      formData.append('file', bufferStream, { filename, contentType: 'application/pdf' });
      formData.append('messaging_product', 'whatsapp');
      formData.append('type', 'application/pdf');
      
      this.debug('OUT.contract.upload.request', {
        cId, url: this.http.defaults.baseURL + `/${phoneNumberId}/media`,
        headers: { Authorization: this.redactBearer(`Bearer ${accessToken}`), ...(formData as any).getHeaders?.() },
        file: { filename, size: pdfBytes.length },
      });
      
      const mediaUpload = await this.http.post(`/${phoneNumberId}/media`, formData, {
        headers: { Authorization: `Bearer ${accessToken}`, ...(formData as any).getHeaders?.() },
      });
      
      this.debug('OUT.contract.upload.response', { cId, status: mediaUpload.status, data: mediaUpload.data });
      
      if (mediaUpload.status >= 400 || !mediaUpload.data?.id) {
        this.error('OUT.contract.upload.failed', { cId, status: mediaUpload.status, data: mediaUpload.data });
        throw new Error(`Failed to upload contract. Status: ${mediaUpload.status}`);
      }
      
      const messagePayload = {
        messaging_product: 'whatsapp',
        to,
        type: 'document',
        document: { id: mediaUpload.data.id, filename },
      };
      
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
        cId, status: sendRes.status, data: sendRes.data,
        fb_headers: { 'x-fb-trace-id': sendRes.headers['x-fb-trace-id'], 'x-fb-rev': sendRes.headers['x-fb-rev'] },
      });
      
      if (sendRes.status >= 400 || errorInfo) {
        this.error('OUT.contract.send.failed', { cId, status: sendRes.status, errorInfo });
        throw new Error(`WhatsApp send contract error: ${sendRes.status} ${errorInfo ? JSON.stringify(errorInfo) : ''}`);
      }
      
      // 7) Persistir chat message
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
