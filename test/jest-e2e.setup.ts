// Set NODE_ENV to test for E2E tests
process.env.NODE_ENV = 'test'

// Force set test database URL - this must override any .env file values
// Prisma reads DATABASE_URL when PrismaClient is instantiated, so we need to set it here
process.env.DATABASE_URL = 'mysql://spark_user:spark_password@localhost:3309/spark_ln_address_test'

// Mock Spark SDK to avoid dynamic import issues (e.g. requiring --experimental-vm-modules)
jest.mock('@buildonspark/spark-sdk', () => {
  const createLightningInvoice = jest.fn().mockResolvedValue({
    invoice: {
      encodedInvoice: 'lnbc1testinvoice',
    },
  })

  return {
    SparkWallet: {
      initialize: jest.fn().mockResolvedValue({
        wallet: {
          createLightningInvoice,
        },
      }),
    },
  }
})

