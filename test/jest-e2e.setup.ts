// Set NODE_ENV to test for E2E tests
process.env.NODE_ENV = 'test'

// Force set test database URL - this must override any .env file values
// Prisma reads DATABASE_URL when PrismaClient is instantiated, so we need to set it here
process.env.DATABASE_URL = 'mysql://spark_user:spark_password@localhost:3309/spark_ln_address_test'

