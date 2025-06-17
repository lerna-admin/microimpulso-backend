import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Branch } from 'src/entities/branch.entity';
import { BranchService } from './branch.service';
import { BranchController } from './branch.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Branch])],
  controllers: [BranchController],
  providers: [BranchService],
})
export class BranchModule {}
