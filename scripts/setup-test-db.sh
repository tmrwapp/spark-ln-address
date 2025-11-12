#!/bin/bash

set -e

TEST_DATABASE_URL="mysql://spark_user:spark_password@localhost:3309/spark_ln_address_test"

echo "Starting test database container..."
docker-compose --profile test up -d mysql-test

echo "Waiting for database to be ready..."
# Wait for the container to be healthy
timeout=60
elapsed=0
while [ $elapsed -lt $timeout ]; do
  if docker exec spark-ln-address-mysql-test mysqladmin ping -h localhost -u spark_user -pspark_password --silent 2>/dev/null; then
    echo "Database is ready!"
    break
  fi
  sleep 1
  elapsed=$((elapsed + 1))
  if [ $((elapsed % 5)) -eq 0 ]; then
    echo "Still waiting... (${elapsed}s/${timeout}s)"
  fi
done

if [ $elapsed -ge $timeout ]; then
  echo "ERROR: Database failed to become ready after ${timeout} seconds"
  echo "Container logs:"
  docker logs spark-ln-address-mysql-test --tail 20
  exit 1
fi

# Give it a few more seconds to fully initialize
echo "Database is ready, waiting 10 more seconds for full initialization..."
sleep 10

# Verify we can actually connect to the database
echo "Verifying database connection..."
if ! docker exec spark-ln-address-mysql-test mysql -u spark_user -pspark_password -e "USE spark_ln_address_test; SELECT 1;" --silent 2>/dev/null; then
  echo "ERROR: Cannot connect to test database"
  exit 1
fi
echo "Database connection verified!"

echo "Running Prisma migrations with test database..."
echo "Using DATABASE_URL: ${TEST_DATABASE_URL}"
# Important: Prisma loads .env files, but environment variables override them
# We set DATABASE_URL both as export (for the script) and inline (for the npx command)
# This ensures Prisma uses the test database URL instead of the one from .env
export DATABASE_URL="$TEST_DATABASE_URL"
# Run Prisma with explicit DATABASE_URL - this will override any value from .env
# Note: Prisma will still show "Environment variables loaded from .env" message,
# but it will actually use the DATABASE_URL from the environment variable
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy

echo "Test database setup complete!"

