import { Test, TestingModule } from '@nestjs/testing';
import { LoanRequestController } from './loan-request.controller';
import { LoanRequestService } from './loan-request.service';

describe('LoanRequestController', () => {
  let controller: LoanRequestController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LoanRequestController],
      providers: [LoanRequestService],
    }).compile();

    controller = module.get<LoanRequestController>(LoanRequestController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
