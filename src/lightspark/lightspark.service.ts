import { Injectable } from '@nestjs/common'
import { SparkWallet } from "@buildonspark/spark-sdk";

export interface InvoiceResult {
  bolt11: string
  expiresAt: Date
}

@Injectable()
export class LightsparkService {
  private sparkWallet?: SparkWallet;
  constructor() {
    SparkWallet.initialize({
      options: {
        network: 'MAINNET',
      }
    }).then(({ wallet }) => {
      this.sparkWallet = wallet as SparkWallet
    })
  }

  async createInvoice(sparkPubKeyHex: string, amountMsat: number, memo: string): Promise<InvoiceResult> {
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
      memo,
    })
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours

    return {
      bolt11: invoice.encodedInvoice,
      expiresAt,
    }
  }
}



