import { Controller, Post, Body, Param, ParseIntPipe } from '@nestjs/common';
import { CampaignService } from './campaign.service';

@Controller('campaign')
export class CampaignController {
    constructor(private readonly campaignService: CampaignService) {}
    
    @Post()
    createCampaign(@Body() body: any) {
        return this.campaignService.createCampaign(body);
    }
    
    @Post(':id/contacts')
    addContactsAndLaunch(
        @Param('id', ParseIntPipe) id: number,
        @Body() body: { contacts: any[] },
    ) {
        return this.campaignService.addContactsAndLaunch(id, body.contacts);
    }
    
}
