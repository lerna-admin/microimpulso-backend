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
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as fs from 'fs';
import * as FormData from 'form-data';
import { Readable } from 'stream';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  
  private TOKEN_TEMP: string =
  'EAAYqvtVC2P8BOZBmS2OI3aewThH3isVJ6KsMKNHCKWJFFM89wu0B05PdpjlSnLXgJwcUXXZBMZAtnt4jGBd57V12jsn26CmZAtytovquZAS7urepJvGZAULhaZCvBxsZCCUSEMW46MTZBzrh8WnDh5Hs8wpywdl1mnyoyygCZCXMcFm1jLYAnrcMZB7izEZBrfStZC9qiwTCcIW2nVnTRGkEVcpc86IDwwwZAN0F4x';
  
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
  
  /**
  * Sends a professionally formatted “Crédito Libre Inversión” contract (PDF) to the
  * client via WhatsApp and stores an OUTGOING chatMessage in the DB.
  */
async sendContractToClient(loanRequestId: number) {
  const loan = await this.loanRequestRepository.findOne({
    where: { id: loanRequestId },
    relations: ['client', 'agent'],
  });

  if (!loan || !loan.client?.phone) {
    throw new NotFoundException('Loan or client not found');
  }

  const client = loan.client;
  const agent  = loan.agent;
  loan.endDateAt = new Date(loan.endDateAt);

  /* ---------- 1. Create PDF & fonts ---------- */
  const pdfDoc   = await PDFDocument.create();
  const helv     = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // page helpers & layout
  const marginX     = 55;
  const columnW     = 480;
  const lineH       = 16;
  const bottomMargin = 60;

  let page   = pdfDoc.addPage([595.28, 841.89]); // A4 portrait
  let cursorY = 800;

  const addPage = () => {
    page = pdfDoc.addPage([595.28, 841.89]);
    cursorY = 800;
  };

  const ensureSpace = (needed = lineH) => {
    if (cursorY - needed < bottomMargin) addPage();
  };

  /* helper draws wrapped text inside a column */
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
      const width    = font.widthOfTextAtSize(testLine, size);
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

  /* ---------- 2. Contract content ---------- */

  // Title
  ensureSpace();
  page.drawText('CONTRATO DE CRÉDITO LIBRE INVERSIÓN', {
    x: marginX,
    y: cursorY,
    size: 14,
    font: helvBold,
  });
  cursorY -= lineH + 6;

  // Intro paragraphs
  drawParagraph(
    `Son partes del presente contrato la sociedad MICROIMPULSO S.A.S., identificada con NIT No. 901000000-0, debidamente constituida y vigilada por la Superintendencia Financiera de Colombia, con domicilio en Bogotá D.C., quien en adelante se denominará EL ACREEDOR, y el(la) señor(a) ${client.name}, identificado(a) con cédula No. ${client.document}, expedida en Bogotá D.C., con domicilio en Bogotá D.C., quien en adelante se denominará EL DEUDOR.`
  );

  drawParagraph(
    `El presente contrato es de los denominados de adhesión, en el cual EL DEUDOR manifiesta que EL ACREEDOR previamente le ha informado que éste ha sido puesto a su disposición a través de medios físicos o electrónicos y tiene como objetivo regular las condiciones generales bajo las cuales opera el producto genéricamente denominado "Crédito Libre Inversión", de ahora en adelante y para los efectos de este contrato denominado "El Producto", celebrado entre EL ACREEDOR y EL DEUDOR, quien mediante la firma de este documento se obliga al cumplimiento de las condiciones aquí pactadas, sin perjuicio de la aplicación de las normas determinadas en el Código de Comercio, el Estatuto Orgánico del Sistema Financiero y demás normas aplicables sobre la materia.`
  );

  drawParagraph(
    `EL DEUDOR, con el fin de asegurar el cumplimiento de las obligaciones aquí adquiridas frente al ACREEDOR, ha firmado un pagaré con espacios en blanco a favor de este, el cual podrá ser llenado en caso de incumplimiento de cualquiera de las obligaciones contraídas por EL DEUDOR con EL ACREEDOR.`
  );

  drawParagraph(
    `Los términos y condiciones particulares del Producto serán los informados y aceptados por EL DEUDOR en el documento denominado "Términos y Condiciones del Crédito Libre Inversión".`
  );

  /* --- 1. Objeto (header) --- */
  ensureSpace();
  page.drawText('1. Objeto', { x: marginX, y: cursorY, size: 12, font: helvBold });
  cursorY -= lineH;

  drawParagraph(
    `El presente contrato tiene por objeto establecer las condiciones generales del PRODUCTO Crédito de Libre Inversión, que consiste en un mutuo comercial en virtud del cual EL ACREEDOR, previa evaluación de riesgo y cumplimiento de las condiciones y políticas de crédito vigentes y de acuerdo con la solvencia que posea, se compromete a desembolsar a favor del DEUDOR una suma determinada de dinero, para ser incondicionalmente restituida por éste dentro de un plazo y tasa previamente pactados, mediante un pago único de capital e intereses remuneratorios, de conformidad con las condiciones generales y particulares del Producto.`
  );

  /* Bold dynamic fields */
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

  /* Sections 2-8 */
  const sections: { title: string; body: string }[] = [
    {
      title: '2. Condiciones Generales del Crédito de Libre Inversión',
      body:
        '2.1. La tasa de interés remuneratoria y la modalidad de la misma, aplicable sobre los saldos insolutos... 2.2. El plazo del Crédito de Libre Inversión será aquel pactado por las partes y contenido en dicho documento. 2.3. El monto del crédito será el aprobado por EL ACREEDOR.',
    },
    {
      title: '3. Condiciones para la utilización de “El Producto”',
      body:
        '3.1. Sujeto a las políticas de crédito, disponibilidad de fondos... 3.4. El registro contable del ACREEDOR será prueba suficiente del desembolso.',
    },
    {
      title: '4. Condiciones de pago',
      body:
        '4.1. EL DEUDOR está obligado al pago incondicional... 4.9. Los pagos a través de bancos externos podrán tener costos según el tarifario vigente.',
    },
    {
      title: '5. Condiciones sobre Seguros',
      body:
        '5.1. EL DEUDOR se obliga a pagar las primas... 5.6. La mora en el pago de primas puede dar lugar a la terminación automática del seguro.',
    },
    {
      title: '6. Comisiones y gastos',
      body:
        '6.1. EL DEUDOR acepta las tarifas informadas y publicadas por EL ACREEDOR. 6.2. EL DEUDOR autoriza el cobro por estudio de crédito...',
    },
    {
      title: '7. Condiciones en caso de incumplimiento',
      body:
        '7.1. En caso de mora, EL ACREEDOR podrá exigir el pago total anticipado... 7.5. El contrato podrá terminarse anticipadamente si se presentan incumplimientos...',
    },
    {
      title: '8. Otras condiciones y autorizaciones',
      body:
        '8.1. Las prórrogas no extinguen garantías ni liberan a codeudores... 8.6. Cualquier modificación contractual será notificada con mínimo 45 días...',
    },
  ];

  sections.forEach(({ title, body }) => {
    ensureSpace();
    page.drawText(title, { x: marginX, y: cursorY, size: 12, font: helvBold });
    cursorY -= lineH;
    drawParagraph(body);
  });

  /* Signature block */
  drawParagraph(
    `En constancia de lo anterior, se firma en la ciudad de Bogotá D.C. a los ${new Date().getDate()} días del mes de ${new Date().toLocaleString('es-CO', { month: 'long' })} del año ${new Date().getFullYear()}.`
  );

  drawParagraph('Acepto en calidad de EL DEUDOR:');
  ensureSpace(30);
  page.drawLine({
    start: { x: marginX, y: cursorY },
    end:   { x: marginX + 250, y: cursorY },
  });
  cursorY -= lineH;
  drawParagraph(`Nombre: ${client.name}`);
  drawParagraph(`Cédula de Ciudadanía: ${client.document}`);

  /* ---------- 3. Save & continue with WhatsApp upload ---------- */
  const pdfBytes = await pdfDoc.save();
  const filename = `LoanContract-${loan.id}.pdf`;
  const filePath = join(__dirname, '..', '..', 'public', 'uploads', 'documents', filename);
  writeFileSync(filePath, pdfBytes);

  /* ---------- 4. Upload to WhatsApp (unchanged) ---------- */
  const accessToken   = this.TOKEN_TEMP;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '696358046884463';

  const bufferStream = new Readable();
  bufferStream.push(pdfBytes);
  bufferStream.push(null);

  const formData = new FormData();
  formData.append('file', bufferStream, { filename, contentType: 'application/pdf' });
  formData.append('messaging_product', 'whatsapp');
  formData.append('type', 'application/pdf');

  const mediaUpload = await axios.post(
    `https://graph.facebook.com/v18.0/${phoneNumberId}/media`,
    formData,
    { headers: { Authorization: `Bearer ${accessToken}`, ...formData.getHeaders() } },
  );

  const mediaId = mediaUpload.data.id;
  if (!mediaId) throw new Error('Failed to upload contract to WhatsApp');

  const messagePayload = {
    messaging_product: 'whatsapp',
    to: client.phone,
    type: 'document',
    document: { id: mediaId, filename },
  };

  await axios.post(
    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
    messagePayload,
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
  );

  /* ---------- 5. Log chatMessage ---------- */
  const chatMessage = this.chatMessageRepository.create({
    content: `📎 Contract sent: ${filename}`,
    direction: 'OUTGOING',
    client,
    ...(agent && { agent }),
    loanRequest: loan,
  });
  await this.chatMessageRepository.save(chatMessage);

  return { success: true, sent: true };
}
}
