import { Injectable } from '@nestjs/common';
import axios from 'axios';
import * as qs from 'qs';
import { CampaignContact } from 'src/entities/campaign-contact.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client } from 'src/entities/client.entity';

@Injectable()
export class VoximplantService {
  private readonly API_URL = 'https://api.voximplant.com/platform_api';
  private readonly API_KEY = process.env.VOXIMPLANT_API_KEY ||"e0cb89b2-f7f7-4203-8a9a-3b459bc112fd" ;
  private readonly ACCOUNT_ID = process.env.VOXIMPLANT_ACCOUNT_ID || "9742011";
  private readonly RULE_ID = process.env.VOXIMPLANT_RULE_ID || "1317432";

  constructor(
    @InjectRepository(Client)
    private readonly clientRepo: Repository<Client>,
  ) {}

  async launchCallListCampaign(
    campaignId: number,
    contacts: CampaignContact[],
  ): Promise<any> {
    const csvRows: string[] = [];

    for (const contact of contacts) {
      const clientId = contact.client?.id;
      if (!clientId) throw new Error('Missing client in contact');

      const client = await this.clientRepo.findOne({ where: { id: clientId } });
      if (!client || !client.phone || !client.name) {
        throw new Error(`Missing data for client ${clientId}`);
      }

      // Personalización básica del mensaje por contacto
      const row = `${client.name};${client.phone}`;
      csvRows.push(row);
    }

    const csvHeader = 'first_name;phone_number';
    const csv = [csvHeader, ...csvRows].join('\n');

    const payload = {
      api_key: this.API_KEY ,
      account_id: this.ACCOUNT_ID ,
      rule_id: this.RULE_ID ,
      name: `campaign_${campaignId}`,
      priority: 1,
      max_simultaneous: 3,
      num_attempts: 1,
      file_content: csv,
      delimiter: ';',
    };

    const encoded = qs.stringify(payload);

    const response = await axios.post(`${this.API_URL}/CreateCallList`, encoded, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    console.log(response)

    return response.data;
  }
}
