import { Test, TestingModule } from '@nestjs/testing'
import { BadRequestException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { AuthService } from './auth.service'
import { PrismaService } from '../prisma/prisma.service'
import { sign, getPublicKey, hashes } from '@noble/secp256k1'
import { randomBytes, createHash, createHmac } from 'crypto'

// Set up SHA-256 hash function for @noble/secp256k1
hashes.sha256 = (m: Uint8Array) => {
  return createHash('sha256').update(m).digest()
}

// Set up HMAC-SHA256 for @noble/secp256k1
hashes.hmacSha256 = (key: Uint8Array, ...ms: Uint8Array[]) => {
  const hmac = createHmac('sha256', key)
  ms.forEach((m) => hmac.update(m))
  return hmac.digest()
}

describe('AuthService', () => {
  let service: AuthService

  const mockPrismaService = {
    authNonce: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    lightningName: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    user: {
      create: jest.fn(),
    },
  }

  const mockConfigService = {
    get: jest.fn(),
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile()

    service = module.get<AuthService>(AuthService)

    // Reset all mocks
    jest.clearAllMocks()
  })

  it('should be defined', () => {
    expect(service).toBeDefined()
  })

  describe('generateAuthChallenge', () => {
    it('should generate k1, callback, and store nonce with expiration', async () => {
      const publicBaseUrl = 'https://example.com'
      mockConfigService.get.mockReturnValue(publicBaseUrl)

      const mockCreatedNonce = {
        id: 'nonce-1',
        k1: 'test-k1-hex',
        expiresAt: new Date(),
        usedAt: null,
        metadataJson: null,
      }

      mockPrismaService.authNonce.create.mockResolvedValue(mockCreatedNonce)

      const result = await service.generateAuthChallenge()

      expect(mockConfigService.get).toHaveBeenCalledWith('PUBLIC_BASE_URL')
      expect(result).toHaveProperty('k1')
      expect(result).toHaveProperty('callback')
      expect(result.k1).toMatch(/^[0-9a-fA-F]{64}$/) // 64 hex chars (32 bytes)
      expect(result.callback).toBe(`${publicBaseUrl}/v1/auth/lnurl/callback`)

      expect(mockPrismaService.authNonce.create).toHaveBeenCalledTimes(1)
      const createCall = mockPrismaService.authNonce.create.mock.calls[0][0]
      expect(createCall.data).toHaveProperty('k1')
      expect(createCall.data).toHaveProperty('expiresAt')
      expect(createCall.data.k1).toBe(result.k1)
      expect(createCall.data.expiresAt).toBeInstanceOf(Date)
      expect(createCall.data.expiresAt.getTime()).toBeGreaterThan(Date.now())
    })

    it('should generate unique k1 values on each call', async () => {
      mockConfigService.get.mockReturnValue('https://example.com')
      mockPrismaService.authNonce.create.mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'nonce-1',
          ...data,
          usedAt: null,
          metadataJson: null,
        }),
      )

      const result1 = await service.generateAuthChallenge()
      const result2 = await service.generateAuthChallenge()

      expect(result1.k1).not.toBe(result2.k1)
    })
  })

  describe('verifyAndBindUsername', () => {
    let validK1: string
    let validPrivateKey: Uint8Array
    let validPublicKey: string
    let validSignature: string
    let validUsername: string

    beforeEach(async () => {
      // Generate a valid k1 (32 bytes hex)
      validK1 = 'a'.repeat(64) // 64 hex chars = 32 bytes

      // Generate a valid secp256k1 key pair for testing
      // Use a deterministic private key for testing (in production, this would be random)
      const privateKeyBuffer = randomBytes(32)
      validPrivateKey = new Uint8Array(privateKeyBuffer)
      const publicKeyPoint = getPublicKey(validPrivateKey, true)
      validPublicKey = Buffer.from(publicKeyPoint).toString('hex')

      // Generate a valid signature
      const k1Bytes = Buffer.from(validK1, 'hex')
      validSignature = Buffer.from(sign(k1Bytes, validPrivateKey)).toString('hex')

      validUsername = 'testuser'
    })

    it('should successfully verify and bind username', async () => {
      const mockNonce = {
        id: 'nonce-1',
        k1: validK1,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes from now
        usedAt: null,
        metadataJson: null,
      }

      const mockUser = {
        id: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      const mockLightningName = {
        id: 'ln-1',
        username: validUsername,
        userId: mockUser.id,
        linkingPubKeyHex: validPublicKey,
        sparkPubKeyHex: null,
        active: true,
      }

      mockPrismaService.authNonce.findUnique.mockResolvedValue(mockNonce)
      mockPrismaService.lightningName.findUnique.mockResolvedValue(null) // Username available
      mockPrismaService.user.create.mockResolvedValue(mockUser)
      mockPrismaService.lightningName.create.mockResolvedValue(mockLightningName)
      mockPrismaService.authNonce.update.mockResolvedValue({
        ...mockNonce,
        usedAt: new Date(),
      })

      const result = await service.verifyAndBindUsername(
        validK1,
        validSignature,
        validPublicKey,
        validUsername,
      )

      expect(result).toEqual({ status: 'OK' })
      expect(mockPrismaService.authNonce.findUnique).toHaveBeenCalledWith({
        where: { k1: validK1 },
      })
      expect(mockPrismaService.lightningName.findUnique).toHaveBeenCalledWith({
        where: { username: validUsername },
      })
      expect(mockPrismaService.user.create).toHaveBeenCalledWith({ data: {} })
      expect(mockPrismaService.lightningName.create).toHaveBeenCalledWith({
        data: {
          username: validUsername,
          userId: mockUser.id,
          linkingPubKeyHex: validPublicKey,
          sparkPubKeyHex: validPublicKey,
        },
      })
      expect(mockPrismaService.authNonce.update).toHaveBeenCalledWith({
        where: { k1: validK1 },
        data: { usedAt: expect.any(Date) },
      })
    })

    it('should successfully verify using UTF-8 k1 encoding', async () => {
      // Generate signature over UTF-8 bytes of k1
      const k1Utf8Bytes = Buffer.from(validK1, 'utf8')
      const utf8Signature = Buffer.from(sign(k1Utf8Bytes, validPrivateKey)).toString('hex')

      const mockNonce = {
        id: 'nonce-1',
        k1: validK1,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        usedAt: null,
        metadataJson: null,
      }

      const mockUser = {
        id: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      mockPrismaService.authNonce.findUnique.mockResolvedValue(mockNonce)
      mockPrismaService.lightningName.findUnique.mockResolvedValue(null)
      mockPrismaService.user.create.mockResolvedValue(mockUser)
      mockPrismaService.lightningName.create.mockResolvedValue({
        id: 'ln-1',
        username: validUsername,
        userId: mockUser.id,
        linkingPubKeyHex: validPublicKey,
        sparkPubKeyHex: null,
        active: true,
      })
      mockPrismaService.authNonce.update.mockResolvedValue({
        ...mockNonce,
        usedAt: new Date(),
      })

      const result = await service.verifyAndBindUsername(
        validK1,
        utf8Signature,
        validPublicKey,
        validUsername,
      )

      expect(result).toEqual({ status: 'OK' })
    })

    it('should verify Set 1 provided by user (DER signature)', async () => {
      const set1 = {
        k1: '5c0fbb5d2a727fa0bcbe6dd94f282b30734b8592717fb461bec9ec9a029ea79a',
        key: '03ca98c2b03f582e8f0149b31faa95ae222384d91021ea88cb4a0f0deef29ee1a9',
        sig: '3044022040da008a0be7719fa169336ea9060f9f88276fc45c1e9521e91625ea7004142a0220432ac9741b1a061761d986584271570c09d98edec06cdd79c5be56b9cd3ae9f0',
      }

      const mockNonce = {
        id: 'nonce-set1',
        k1: set1.k1,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        usedAt: null,
        metadataJson: null,
      }

      mockPrismaService.authNonce.findUnique.mockResolvedValue(mockNonce)
      mockPrismaService.lightningName.findUnique.mockResolvedValue(null)
      mockPrismaService.user.create.mockResolvedValue({ id: 'user-set1' })
      mockPrismaService.lightningName.create.mockResolvedValue({})
      mockPrismaService.authNonce.update.mockResolvedValue({})

      const result = await service.verifyAndBindUsername(set1.k1, set1.sig, set1.key, 'user1')
      expect(result).toEqual({ status: 'OK' })
    })

    it('should verify Set 2 provided by user (Compact signature)', async () => {
      const set2 = {
        k1: 'f037091d7fe29ac3f173b072efde300c27a8e100c189262d57e2f583dc23179b',
        key: '03ca98c2b03f582e8f0149b31faa95ae222384d91021ea88cb4a0f0deef29ee1a9',
        sig: 'a9e86789e6f955d2babcd06e9b5dfc598c4eb96c3aa0b9eac8887c0d7de3b67d29a35fb4b4ee4cc834e893850c044a4ed31cd37439bdd547182759f556719fd4',
      }

      const mockNonce = {
        id: 'nonce-set2',
        k1: set2.k1,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        usedAt: null,
        metadataJson: null,
      }

      mockPrismaService.authNonce.findUnique.mockResolvedValue(mockNonce)
      mockPrismaService.lightningName.findUnique.mockResolvedValue(null)
      mockPrismaService.user.create.mockResolvedValue({ id: 'user-set2' })
      mockPrismaService.lightningName.create.mockResolvedValue({})
      mockPrismaService.authNonce.update.mockResolvedValue({})

      const result = await service.verifyAndBindUsername(set2.k1, set2.sig, set2.key, 'user2')
      expect(result).toEqual({ status: 'OK' })
    })

    it('should normalize username to lowercase', async () => {
      const mockNonce = {
        id: 'nonce-1',
        k1: validK1,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        usedAt: null,
        metadataJson: null,
      }

      const mockUser = {
        id: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      mockPrismaService.authNonce.findUnique.mockResolvedValue(mockNonce)
      mockPrismaService.lightningName.findUnique.mockResolvedValue(null)
      mockPrismaService.user.create.mockResolvedValue(mockUser)
      mockPrismaService.lightningName.create.mockResolvedValue({
        id: 'ln-1',
        username: 'testuser',
        userId: mockUser.id,
        linkingPubKeyHex: validPublicKey,
        sparkPubKeyHex: null,
        active: true,
      })
      mockPrismaService.authNonce.update.mockResolvedValue({
        ...mockNonce,
        usedAt: new Date(),
      })

      await service.verifyAndBindUsername(validK1, validSignature, validPublicKey, 'TestUser')

      expect(mockPrismaService.lightningName.findUnique).toHaveBeenCalledWith({
        where: { username: 'testuser' },
      })
      expect(mockPrismaService.lightningName.create).toHaveBeenCalledWith({
        data: {
          username: 'testuser',
          userId: mockUser.id,
          linkingPubKeyHex: validPublicKey,
          sparkPubKeyHex: validPublicKey,
        },
      })
    })

    it('should throw BadRequestException if k1 is not found', async () => {
      mockPrismaService.authNonce.findUnique.mockResolvedValue(null)

      await expect(
        service.verifyAndBindUsername(validK1, validSignature, validPublicKey, validUsername),
      ).rejects.toThrow(BadRequestException)

      await expect(
        service.verifyAndBindUsername(validK1, validSignature, validPublicKey, validUsername),
      ).rejects.toMatchObject({
        response: { status: 'ERROR', reason: 'Invalid k1' },
      })
    })

    it('should throw BadRequestException if k1 is already used', async () => {
      const mockNonce = {
        id: 'nonce-1',
        k1: validK1,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        usedAt: new Date(), // Already used
        metadataJson: null,
      }

      mockPrismaService.authNonce.findUnique.mockResolvedValue(mockNonce)

      await expect(
        service.verifyAndBindUsername(validK1, validSignature, validPublicKey, validUsername),
      ).rejects.toThrow(BadRequestException)

      await expect(
        service.verifyAndBindUsername(validK1, validSignature, validPublicKey, validUsername),
      ).rejects.toMatchObject({
        response: { status: 'ERROR', reason: 'k1 already used' },
      })
    })

    it('should throw BadRequestException if k1 is expired', async () => {
      const mockNonce = {
        id: 'nonce-1',
        k1: validK1,
        expiresAt: new Date(Date.now() - 1000), // Expired 1 second ago
        usedAt: null,
        metadataJson: null,
      }

      mockPrismaService.authNonce.findUnique.mockResolvedValue(mockNonce)

      await expect(
        service.verifyAndBindUsername(validK1, validSignature, validPublicKey, validUsername),
      ).rejects.toThrow(BadRequestException)

      await expect(
        service.verifyAndBindUsername(validK1, validSignature, validPublicKey, validUsername),
      ).rejects.toMatchObject({
        response: { status: 'ERROR', reason: 'k1 expired' },
      })
    })

    it('should throw BadRequestException if signature is invalid', async () => {
      const mockNonce = {
        id: 'nonce-1',
        k1: validK1,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        usedAt: null,
        metadataJson: null,
      }

      mockPrismaService.authNonce.findUnique.mockResolvedValue(mockNonce)

      const invalidSignature = 'invalid-signature-hex'

      await expect(
        service.verifyAndBindUsername(validK1, invalidSignature, validPublicKey, validUsername),
      ).rejects.toThrow(BadRequestException)

      await expect(
        service.verifyAndBindUsername(validK1, invalidSignature, validPublicKey, validUsername),
      ).rejects.toMatchObject({
        response: { status: 'ERROR', reason: 'Invalid signature' },
      })
    })

    it('should throw BadRequestException if username is already taken', async () => {
      const mockNonce = {
        id: 'nonce-1',
        k1: validK1,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        usedAt: null,
        metadataJson: null,
      }

      const existingLightningName = {
        id: 'ln-existing',
        username: validUsername,
        userId: 'user-existing',
        linkingPubKeyHex: 'existing-key',
        sparkPubKeyHex: null,
        active: true,
      }

      mockPrismaService.authNonce.findUnique.mockResolvedValue(mockNonce)
      mockPrismaService.lightningName.findUnique.mockResolvedValue(existingLightningName)

      await expect(
        service.verifyAndBindUsername(validK1, validSignature, validPublicKey, validUsername),
      ).rejects.toThrow(BadRequestException)

      await expect(
        service.verifyAndBindUsername(validK1, validSignature, validPublicKey, validUsername),
      ).rejects.toMatchObject({
        response: { status: 'ERROR', reason: 'Username already taken' },
      })

      expect(mockPrismaService.user.create).not.toHaveBeenCalled()
      expect(mockPrismaService.lightningName.create).not.toHaveBeenCalled()
    })

    it('should verify signature with different public key formats', async () => {
      const mockNonce = {
        id: 'nonce-1',
        k1: validK1,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        usedAt: null,
        metadataJson: null,
      }

      const mockUser = {
        id: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      // Test with uncompressed public key (130 hex chars)
      const publicKeyUncompressed = Buffer.from(getPublicKey(validPrivateKey, false)).toString('hex')

      mockPrismaService.authNonce.findUnique.mockResolvedValue(mockNonce)
      mockPrismaService.lightningName.findUnique.mockResolvedValue(null)
      mockPrismaService.user.create.mockResolvedValue(mockUser)
      mockPrismaService.lightningName.create.mockResolvedValue({
        id: 'ln-1',
        username: validUsername,
        userId: mockUser.id,
        linkingPubKeyHex: publicKeyUncompressed,
        sparkPubKeyHex: null,
        active: true,
      })
      mockPrismaService.authNonce.update.mockResolvedValue({
        ...mockNonce,
        usedAt: new Date(),
      })

      const result = await service.verifyAndBindUsername(
        validK1,
        validSignature,
        publicKeyUncompressed,
        validUsername,
      )

      expect(result).toEqual({ status: 'OK' })
    })
  })

  describe('verifySignature (private method tested indirectly)', () => {
    it('should reject invalid k1 format', async () => {
      const mockNonce = {
        id: 'nonce-1',
        k1: 'invalid-k1',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        usedAt: null,
        metadataJson: null,
      }

      mockPrismaService.authNonce.findUnique.mockResolvedValue(mockNonce)

      await expect(
        service.verifyAndBindUsername(
          'invalid-k1',
          'signature',
          '0'.repeat(66),
          'testuser',
        ),
      ).rejects.toThrow(BadRequestException)
    })

    it('should reject invalid signature format', async () => {
      const validK1 = 'a'.repeat(64)
      const mockNonce = {
        id: 'nonce-1',
        k1: validK1,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        usedAt: null,
        metadataJson: null,
      }

      mockPrismaService.authNonce.findUnique.mockResolvedValue(mockNonce)

      await expect(
        service.verifyAndBindUsername(validK1, 'not-hex!', '0'.repeat(66), 'testuser'),
      ).rejects.toThrow(BadRequestException)
    })

    it('should reject invalid public key format', async () => {
      const validK1 = 'a'.repeat(64)
      const mockNonce = {
        id: 'nonce-1',
        k1: validK1,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        usedAt: null,
        metadataJson: null,
      }

      mockPrismaService.authNonce.findUnique.mockResolvedValue(mockNonce)

      await expect(
        service.verifyAndBindUsername(validK1, 'signature', 'invalid-key', 'testuser'),
      ).rejects.toThrow(BadRequestException)
    })
  })
})

