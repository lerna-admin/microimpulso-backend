import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigParam } from '../entities/config-param.entity';
import { ConfigParamService } from './config-param.service';
import { ConfigParamController } from './config-param.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ConfigParam])],
  controllers: [ConfigParamController],
  providers: [ConfigParamService],
  exports: [ConfigParamService],     // export in case other modules need it
})
export class ConfigParamModule {}
