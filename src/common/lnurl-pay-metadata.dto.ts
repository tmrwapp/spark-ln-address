export class LnurlPayMetadataDto {
  status: 'OK'
  tag: 'payRequest'
  callback: string
  minSendable: number // msats
  maxSendable: number // msats
  metadata: string[][] // JSON string array for LNURL metadata
  commentAllowed?: number // max comment length
}
