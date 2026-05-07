// Internal DTO — callers are trusted services (e.g. PR6's webhook handler).
// No class-validator decorators are required here; validation is handled at the
// service boundary via TypeScript types alone.
export class CreateRefundCaseDto {
  invoiceId: string
  amountSats: number
  reason: string
  externalRef?: string
}
