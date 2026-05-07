import { IsOptional, IsString } from 'class-validator'

export class MarkPaidDto {
  @IsOptional()
  @IsString()
  externalRef?: string

  @IsOptional()
  @IsString()
  payeeLnAddress?: string
}
