// Set NODE_ENV to test for E2E tests
process.env.NODE_ENV = 'test'

// Set test database URL if not already set
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'mysql://spark_user:spark_password@localhost:3309/spark_ln_address_test'
}

