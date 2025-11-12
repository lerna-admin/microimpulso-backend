///src/chat/chat.controller.ts
import { Controller, Get, Post, Query, Body, Req, Res, Param, NotFoundException, UseInterceptors, UploadedFile, ParseIntPipe} from '@nestjs/common';
import { Response, Request } from 'express';
import { ChatService } from './chat.service';
import { FileInterceptor } from '@nestjs/platform-express';

@Controller('/chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}
  
  @Get()
  verifyToken(@Query() query, @Res() res: Response) {
    const VERIFY_TOKEN = 'micropulso_token';
    console.log("enyto mensaje")
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    
    if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    
    return res.sendStatus(403);
  }
  
  @Post('/send/:clientId')
  async sendMessageToClient(
    @Param('clientId') clientId: number,
    @Body('message') message: string,
  ) {
    if (!message || message.trim().length === 0) {
      throw new NotFoundException('Message body is required.');
    }	
    console.log("before the return")
    return this.chatService.sendMessageToClient(clientId, message);
  }

  
  
  @Post()
  async handleIncomingMessage(
    @Body() body: any,
    @Req() _req: Request,
    @Res() res: Response,
  ) {
    // 1) responder 200 YA
    res.sendStatus(200);
    
    // 2) procesar en background
    setImmediate(async () => {
      try {
        await this.chatService.processIncoming(body);
      } catch (e) {
        console.error('Error procesando webhook:', e);
      }
    });
  }
  
  @Get('/agent/:agentId/conversations')
  async getAgentConversations(@Param('agentId') agentId: number) {
    return this.chatService.getAgentConversations(agentId);
  }
  @UseInterceptors(FileInterceptor('file'))
  @Post('send-simulation')
  async sendSimulation(
    @UploadedFile() file: Express.Multer.File,
    @Body('clientId') clientId: number,
  ) {
    return this.chatService.sendSimulationToClient(+clientId, file);
  }

  @Post('/send-contract/:loanRequestId')
  async sendContractToClient(
    @Param('loanRequestId', ParseIntPipe) loanRequestId: number,
  ) {
    return this.chatService.sendContractToClient(loanRequestId);
  }

@Get(':id/contract/download')
async download(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
  const { buffer, filename, mime } = await this.chatService.generateContractForDownload(id);
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

  

  
}

