-- Grant all privileges to spark_user for Prisma migrations (including shadow database creation)
GRANT ALL PRIVILEGES ON *.* TO 'spark_user'@'%' WITH GRANT OPTION;
FLUSH PRIVILEGES;

