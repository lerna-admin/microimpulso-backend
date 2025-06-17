import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Campaign } from 'src/entities/campaign.entity';
import { CampaignContact } from 'src/entities/campaign-contact.entity';
import { CampaignController } from './campaign.controller';
import { CampaignService } from './campaign.service';
import { VoximplantService } from './voximplant.service';
import { Client } from 'src/entities/client.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Campaign, CampaignContact, Client])],
  controllers: [CampaignController],
  providers: [CampaignService, VoximplantService],
})
export class CampaignModule {}
