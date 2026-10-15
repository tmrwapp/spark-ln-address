import { Injectable, Logger } from '@nestjs/common'
import { SparkWallet } from '@buildonspark/spark-sdk'
import { bolt11DescriptionHash } from '../common/bolt11-description-hash'

export interface InvoiceResult {
  bolt11: string
  expiresAt: Date
}

@Injectable()
export class LightsparkService {
  private readonly logger = new Logger(LightsparkService.name)
  private sparkWallet?: SparkWallet
  constructor() {
    SparkWallet.initialize({
      options: {
        network: 'MAINNET',
      },
    }).then(({ wallet }) => {
      this.sparkWallet = wallet as SparkWallet
    })
  }

  /**
   * `descriptionHash` becomes the invoice's BOLT11 `h` tag (hex sha256 of the
   * LNURL-pay metadata). The SDK refuses a memo alongside it, so the invoice
   * carries no text description.
   *
   * The SDK does not check that the SSP honoured the hash. A missing or wrong
   * `h` is logged as an error but the invoice is still returned: strict
   * wallets (Strike) refuse it either way, while every other wallet can
   * still pay it, which a refusal here would take away.
   */
  async createInvoice(
    sparkPubKeyHex: string,
    amountMsat: number,
    descriptionHash: string,
  ): Promise<InvoiceResult> {
    if (!this.sparkWallet) {
      throw new Error('Spark wallet not initialized')
    }

    // Convert msat to sat (round down)
    const amountSats = Math.floor(amountMsat / 1000)

    if (amountSats <= 0) {
      throw new Error('Amount must be at least 1000 msat (1 sat)')
    }

    const { invoice } = await this.sparkWallet.createLightningInvoice({
      receiverIdentityPubkey: sparkPubKeyHex,
      amountSats,
      descriptionHash,
    })
    const foundHash = bolt11DescriptionHash(invoice.encodedInvoice)
    if (foundHash !== descriptionHash) {
      // Payment hash and both description hashes tie this to a failed
      // payment; none of them identifies the customer.
      this.logger.error({
        event: 'lightspark.description_hash_mismatch',
        message: 'Spark invoice lacks the requested description hash',
        paymentHash: invoice.paymentHash,
        expectedDescriptionHash: descriptionHash,
        foundDescriptionHash: foundHash,
      })
    }
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours

    return {
      bolt11: invoice.encodedInvoice,
      expiresAt,
    }
  }
}
