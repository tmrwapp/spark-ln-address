import { IsOptional, IsString } from 'class-validator'

export class MarkAbandonedDto {
  @IsOptional()
  @IsString()
  reason?: string
}
