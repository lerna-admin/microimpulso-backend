import { Controller, Get, Post, Query, Body, Req, Res } from '@nestjs/common';
import { Response, Request } from 'express';
import { ChatService } from './chat.service';

@Controller('/chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get()
  verifyToken(@Query() query, @Res() res: Response) {
    const VERIFY_TOKEN = 'micropulso_token';

    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
  }

  @Post()
  handleMessage(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    this.chatService.processIncoming(body);
    return res.sendStatus(200);
  }
}
