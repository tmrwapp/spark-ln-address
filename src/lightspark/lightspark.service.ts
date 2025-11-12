import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

export interface InvoiceResult {
  bolt11: string
  expiresAt: Date
}

// TODO: Replace with actual Lightspark SDK when available
@Injectable()
export class LightsparkService {
  constructor(private readonly configService: ConfigService) {}

  async createInvoice(amountMsat: number, memo: string): Promise<InvoiceResult> {
    // Validate configuration
    const clientId = this.configService.get<string>('LIGHTSPARK_CLIENT_ID')
    const clientSecret = this.configService.get<string>('LIGHTSPARK_CLIENT_SECRET')
    const nodeId = this.configService.get<string>('LIGHTSPARK_NODE_ID')

    if (!clientId || !clientSecret || !nodeId) {
      throw new Error('Lightspark configuration missing')
    }

    // Convert msat to sat (round down)
    const amountSat = Math.floor(amountMsat / 1000)

    if (amountSat <= 0) {
      throw new Error('Amount must be at least 1000 msat (1 sat)')
    }

    // TODO: Implement actual Lightspark SDK integration
    // For now, return a mock response
    const mockBolt11 = `lnbc${amountSat}0n1p${Date.now()}...` // Mock BOLT11
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours

    return {
      bolt11: mockBolt11,
      expiresAt,
    }
  }
}



