import { Test, TestingModule } from '@nestjs/testing'
import { NotFoundException, BadRequestException, BadGatewayException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { LnurlController } from './lnurl.controller'
import { LnurlService } from './lnurl.service'
import { LightsparkService } from '../lightspark/lightspark.service'
import { SwapService } from '../swap/swap.service'
import * as sparkAddressUtils from '../common/spark-address.utils'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_BOLT11 = 'lnbc1_usdb_mock_bolt11'
const MOCK_SPARK_ADDRESS = 'spark1qmockaddress'

const MOCK_LIGHTNING_NAME_USDB = {
  id: 'ln-1',
  username: 'alice',
  linkingPubKeyHex: '02a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  active: true,
  userId: 'u-1',
  user: {
    id: 'u-1',
    defaultReceivingCurrency: 'USDB',
  },
}

const MOCK_LIGHTNING_NAME_SATS = {
  ...MOCK_LIGHTNING_NAME_USDB,
  user: {
    id: 'u-1',
    defaultReceivingCurrency: 'SATS',
  },
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeConfigService(overrides: Record<string, string | undefined> = {}): Partial<ConfigService> {
  const defaults: Record<string, string | undefined> = {
    PUBLIC_BASE_URL: 'https://pay.example.com',
    USDB_ENABLED: 'true',
    SPARK_NETWORK: 'MAINNET',
    ...overrides,
  }
  return {
    get: jest.fn((key: string) => defaults[key] ?? undefined),
  }
}

function makeLnurlServiceMock() {
  return {
    findActiveLightningNameWithUser: jest.fn().mockResolvedValue(MOCK_LIGHTNING_NAME_USDB),
    findActiveLightningName: jest.fn().mockResolvedValue(MOCK_LIGHTNING_NAME_USDB),
    createInvoice: jest.fn().mockResolvedValue({ id: 'inv-placeholder-1' }),
  }
}

function makeSwapServiceMock() {
  return {
    initiateOnramp: jest.fn().mockResolvedValue({ bolt11: MOCK_BOLT11, replayed: false }),
  }
}

function makeLightsparkServiceMock() {
  return {
    createInvoice: jest.fn().mockResolvedValue({ bolt11: 'lnbc1_sats_bolt11', expiresAt: new Date() }),
  }
}

// ---------------------------------------------------------------------------
// LnurlController unit tests
// ---------------------------------------------------------------------------

describe('LnurlController', () => {
  let controller: LnurlController
  let lnurlService: ReturnType<typeof makeLnurlServiceMock>
  let swapService: ReturnType<typeof makeSwapServiceMock>
  let lightsparkService: ReturnType<typeof makeLightsparkServiceMock>
  let configService: Partial<ConfigService>
  let encodeSparkAddressSpy: jest.SpyInstance

  beforeEach(async () => {
    lnurlService = makeLnurlServiceMock()
    swapService = makeSwapServiceMock()
    lightsparkService = makeLightsparkServiceMock()
    configService = makeConfigService()

    // Default: encodeSparkAddress resolves cleanly
    encodeSparkAddressSpy = jest
      .spyOn(sparkAddressUtils, 'encodeSparkAddress')
      .mockResolvedValue(MOCK_SPARK_ADDRESS)

    const module: TestingModule = await Test.createTestingModule({
      controllers: [LnurlController],
      providers: [
        { provide: LnurlService, useValue: lnurlService },
        { provide: LightsparkService, useValue: lightsparkService },
        { provide: ConfigService, useValue: configService },
        { provide: SwapService, useValue: swapService },
      ],
    }).compile()

    controller = module.get<LnurlController>(LnurlController)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // getLnurlPayMetadata
  // -------------------------------------------------------------------------

  describe('getLnurlPayMetadata', () => {
    it('returns LNURL-Pay metadata for a known username', async () => {
      lnurlService.findActiveLightningName.mockResolvedValueOnce({
        ...MOCK_LIGHTNING_NAME_USDB,
        username: 'alice',
      })

      const result = await controller.getLnurlPayMetadata('alice')

      expect(result).toMatchObject({
        status: 'OK',
        tag: 'payRequest',
        callback: expect.stringContaining('/lnurl/callback/alice'),
      })
    })

    it('throws NotFoundException for unknown username', async () => {
      lnurlService.findActiveLightningName.mockResolvedValueOnce(null)

      await expect(controller.getLnurlPayMetadata('ghost')).rejects.toThrow(NotFoundException)
    })
  })

  // -------------------------------------------------------------------------
  // handleLnurlCallback — kill switch
  // -------------------------------------------------------------------------

  describe('handleLnurlCallback — USDB kill switch', () => {
    it('USDB_ENABLED=false with USDB-preference user → falls through to SATS path', async () => {
      configService = makeConfigService({ USDB_ENABLED: 'false' })

      const module: TestingModule = await Test.createTestingModule({
        controllers: [LnurlController],
        providers: [
          { provide: LnurlService, useValue: lnurlService },
          { provide: LightsparkService, useValue: lightsparkService },
          { provide: ConfigService, useValue: configService },
          { provide: SwapService, useValue: swapService },
        ],
      }).compile()

      const ctrl = module.get<LnurlController>(LnurlController)

      const result = await ctrl.handleLnurlCallback('alice', '1000')

      // Kill switch: swap service must NOT be called
      expect(swapService.initiateOnramp).not.toHaveBeenCalled()
      // SATS path calls lightspark
      expect(lightsparkService.createInvoice).toHaveBeenCalled()
      expect(result).toMatchObject({ pr: 'lnbc1_sats_bolt11', routes: [] })
    })

    it('USDB_ENABLED not set (undefined) with USDB-preference user → SATS path', async () => {
      configService = makeConfigService({ USDB_ENABLED: undefined })

      const module: TestingModule = await Test.createTestingModule({
        controllers: [LnurlController],
        providers: [
          { provide: LnurlService, useValue: lnurlService },
          { provide: LightsparkService, useValue: lightsparkService },
          { provide: ConfigService, useValue: configService },
          { provide: SwapService, useValue: swapService },
        ],
      }).compile()

      const ctrl = module.get<LnurlController>(LnurlController)

      const result = await ctrl.handleLnurlCallback('alice', '1000')

      expect(swapService.initiateOnramp).not.toHaveBeenCalled()
      expect(lightsparkService.createInvoice).toHaveBeenCalled()
      expect(result).toMatchObject({ pr: 'lnbc1_sats_bolt11', routes: [] })
    })
  })

  // -------------------------------------------------------------------------
  // handleLnurlCallback — routing branches
  // -------------------------------------------------------------------------

  describe('handleLnurlCallback — routing', () => {
    it('USDB_ENABLED=true + USDB preference → calls SwapService.initiateOnramp with idempotencyKey, no prior DB write, returns bolt11', async () => {
      const result = await controller.handleLnurlCallback('alice', '5000')

      expect(encodeSparkAddressSpy).toHaveBeenCalledWith(
        MOCK_LIGHTNING_NAME_USDB.linkingPubKeyHex,
        'MAINNET',
      )

      // No Invoice was created before SwapService call
      expect(lnurlService.createInvoice).not.toHaveBeenCalled()

      // SwapService called with idempotencyKey, lightningNameId, amountMsat, amountSats, recipientSparkAddress
      expect(swapService.initiateOnramp).toHaveBeenCalledWith(
        expect.objectContaining({
          lightningNameId: 'ln-1',
          amountMsat: 5000,
          amountSats: 5, // floor(5000 / 1000)
          recipientSparkAddress: MOCK_SPARK_ADDRESS,
        }),
      )
      // idempotencyKey is a cuid string — just verify it's a non-empty string
      const callArg = (swapService.initiateOnramp as jest.Mock).mock.calls[0][0]
      expect(typeof callArg.idempotencyKey).toBe('string')
      expect(callArg.idempotencyKey.length).toBeGreaterThan(0)

      expect(result).toEqual({ pr: MOCK_BOLT11, routes: [] })
    })

    it('SATS preference with USDB_ENABLED=true → SATS path, SwapService NOT called', async () => {
      lnurlService.findActiveLightningNameWithUser.mockResolvedValueOnce(MOCK_LIGHTNING_NAME_SATS)

      const result = await controller.handleLnurlCallback('alice', '2000')

      expect(swapService.initiateOnramp).not.toHaveBeenCalled()
      expect(lightsparkService.createInvoice).toHaveBeenCalled()
      expect(result).toMatchObject({ pr: 'lnbc1_sats_bolt11', routes: [] })
    })

    it('throws BadRequestException when amount parameter is missing', async () => {
      await expect(controller.handleLnurlCallback('alice', undefined as any)).rejects.toThrow(
        BadRequestException,
      )
    })

    it('throws BadRequestException when amount is below MIN_SENDABLE_MSAT', async () => {
      await expect(controller.handleLnurlCallback('alice', '500')).rejects.toThrow(
        BadRequestException,
      )
    })

    it('throws BadRequestException when amount is above MAX_SENDABLE_MSAT', async () => {
      await expect(
        controller.handleLnurlCallback('alice', '99999999999999'),
      ).rejects.toThrow(BadRequestException)
    })

    it('throws NotFoundException when username is not found', async () => {
      lnurlService.findActiveLightningNameWithUser.mockResolvedValueOnce(null)

      await expect(controller.handleLnurlCallback('ghost', '1000')).rejects.toThrow(
        NotFoundException,
      )
    })

    it('throws BadRequestException when linkingPubKeyHex is missing', async () => {
      lnurlService.findActiveLightningNameWithUser.mockResolvedValueOnce({
        ...MOCK_LIGHTNING_NAME_USDB,
        linkingPubKeyHex: null,
      })

      await expect(controller.handleLnurlCallback('alice', '1000')).rejects.toThrow(
        BadRequestException,
      )
    })
  })

  // -------------------------------------------------------------------------
  // handleLnurlCallback — USDB error paths
  // -------------------------------------------------------------------------

  describe('handleLnurlCallback — USDB error paths', () => {
    it('encodeSparkAddress failure → returns { status: ERROR, reason: "Invalid Spark address" }', async () => {
      encodeSparkAddressSpy.mockRejectedValueOnce(new Error('bad pubkey'))

      const result = await controller.handleLnurlCallback('alice', '1000')

      expect(result).toEqual({ status: 'ERROR', reason: 'Invalid Spark address' })
      // No invoice created, no swap attempted
      expect(lnurlService.createInvoice).not.toHaveBeenCalled()
      expect(swapService.initiateOnramp).not.toHaveBeenCalled()
    })

    it('SwapService.initiateOnramp throws BadGatewayException with code → returns { status: ERROR, reason: code }, no DB cleanup', async () => {
      const apiError = new BadGatewayException({ code: 'unsupported_route', message: 'Route not supported' })
      swapService.initiateOnramp.mockRejectedValueOnce(apiError)

      const result = await controller.handleLnurlCallback('alice', '1000')

      expect(result).toEqual({ status: 'ERROR', reason: 'unsupported_route' })
      // No invoice was created — nothing to clean up
      expect(lnurlService.createInvoice).not.toHaveBeenCalled()
    })

    it('SwapService.initiateOnramp throws with err.message → returns { status: ERROR, reason: message }', async () => {
      const plainError = new Error('service_unavailable')
      swapService.initiateOnramp.mockRejectedValueOnce(plainError)

      const result = await controller.handleLnurlCallback('alice', '1000')

      expect(result).toEqual({ status: 'ERROR', reason: 'service_unavailable' })
      expect(lnurlService.createInvoice).not.toHaveBeenCalled()
    })

    it('SwapService.initiateOnramp throws non-Error object → returns { status: ERROR, reason: "service_unavailable" }', async () => {
      // Non-Error throw with no message or response.code
      swapService.initiateOnramp.mockRejectedValueOnce({ code: 42 })

      const result = await controller.handleLnurlCallback('alice', '1000')

      expect(result).toEqual({ status: 'ERROR', reason: 'service_unavailable' })
      expect(lnurlService.createInvoice).not.toHaveBeenCalled()
    })
  })
})
