import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Country } from 'src/entities/country.entity';
import { Branch } from 'src/entities/branch.entity';
import { Client } from 'src/entities/client.entity';
import { User } from 'src/entities/user.entity';
import { CountriesService } from './country.service';
import { CountriesController } from './country.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Country, Branch, Client, User])],
  controllers: [CountriesController],
  providers: [CountriesService],
  exports: [CountriesService],
})
export class CountriesModule {}
