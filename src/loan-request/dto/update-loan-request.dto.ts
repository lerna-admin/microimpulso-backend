import { PartialType } from '@nestjs/mapped-types';
import { CreateLoanRequestDto } from './create-loan-request.dto';

export class UpdateLoanRequestDto extends PartialType(CreateLoanRequestDto) {}
