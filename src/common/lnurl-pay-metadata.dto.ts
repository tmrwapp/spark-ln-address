export class LnurlPayMetadataDto {
  status: 'OK'
  tag: 'payRequest'
  callback: string
  minSendable: number // msats
  maxSendable: number // msats
  metadata: string // JSON-encoded metadata array (LUD-06: raw string for sha256 binding)
  commentAllowed?: number // max comment length
}
