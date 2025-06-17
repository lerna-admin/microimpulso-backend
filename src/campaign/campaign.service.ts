import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Campaign } from 'src/entities/campaign.entity';
import { CampaignContact } from 'src/entities/campaign-contact.entity';
import { Client } from 'src/entities/client.entity';
import { VoximplantService } from './voximplant.service';

@Injectable()
export class CampaignService {
  constructor(
    @InjectRepository(Campaign)
    private campaignRepo: Repository<Campaign>,
    @InjectRepository(CampaignContact)
    private contactRepo: Repository<CampaignContact>,
    @InjectRepository(Client)
    private clientRepo: Repository<Client>,
    private readonly voximplantService: VoximplantService,
  ) {}

  /** Creates a new campaign entry */
  async createCampaign(body: any) {
    const campaign = this.campaignRepo.create({
      name: body.name,
      description: body.description,
      createdBy: { id: body.userId },
    });
    return this.campaignRepo.save(campaign);
  }

  /**
   * Stores contacts, pushes a single Call List to Voximplant,
   * and updates local statuses.
   */
  async addContactsAndLaunch(campaignId: number, contacts: any[]) {
    if (!Array.isArray(contacts) || contacts.length === 0) {
      throw new BadRequestException('contacts array is required');
    }

    const campaign = await this.campaignRepo.findOne({
      where: { id: campaignId },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');

    campaign.status = 'running';
    campaign.startedAt = new Date();
    await this.campaignRepo.save(campaign);

    /* 1. Persist every contact first */
    const saved: CampaignContact[] = [];
    for (const raw of contacts) {
      const contact = this.contactRepo.create({
        ttsScript: raw.ttsScript,
        campaign: { id: campaign.id },
        client: raw.clientId ? { id: raw.clientId } : undefined,
        callStatus: 'pending',
      });
      saved.push(await this.contactRepo.save(contact));
    }

    /* 2. Fire a single Call List request */
    try {
      await this.voximplantService.launchCallListCampaign(campaign.id, saved);
      saved.forEach((c) => (c.callStatus = 'in_progress'));
    } catch (err) {
      saved.forEach((c) => {
        c.callStatus = 'failed';
        c.result = err.message;
      });
    }

    /* 3. Timestamp every attempt */
    const now = new Date();
    saved.forEach((c) => (c.attemptedAt = now));
    await this.contactRepo.save(saved);

    campaign.status = 'completed';
    campaign.completedAt = new Date();
    await this.campaignRepo.save(campaign);

    return { message: 'Campaign completed', totalContacts: contacts.length };
  }
}
