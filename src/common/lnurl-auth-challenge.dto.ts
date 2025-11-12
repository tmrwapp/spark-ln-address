export class LnurlAuthChallengeDto {
  tag: 'login'
  k1: string // 32-byte hex nonce
  callback: string
  domain?: string
}





