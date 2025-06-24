import {
    Controller,
    Get,
    Put,
    Param,
    Body,
    NotFoundException,
  } from '@nestjs/common';
  import { ConfigParamService } from './config-param.service';
  
  @Controller('config')
  export class ConfigParamController {
    constructor(private readonly svc: ConfigParamService) {}
  
    /** GET /config                    – list all key/value pairs */
    @Get()
    list() {
      return this.svc.findAll(); // -> Promise<ConfigParam[]>
    }
  
    /** GET /config/:key               – single param */
    @Get(':key')
    async getOne(@Param('key') key: string) {
      const item = await this.svc.findOne(key); // -> Promise<ConfigParam | null>
      if (!item) throw new NotFoundException(`Config key “${key}” not found`);
      return item;
    }
  
    /** PUT /config/:key               – create or update */
    @Put(':key')
    upsert(
      @Param('key') key: string,
      @Body('value') value: string,
    ) {
      return this.svc.upsert(key, value); // -> Promise<ConfigParam>
    }
  }
  