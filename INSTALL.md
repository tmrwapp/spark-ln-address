# Production Installation Guide

## Prerequisites

- Node.js (v20+ recommended)
- Docker and Docker Compose
- PM2 for process management
- NGINX (for reverse proxy and HTTPS)
- Domain name with DNS configured

## 1. Configuration

### Create Environment File

1. Create `.env` file from example:
   ```bash
   cp env.example .env
   ```

2. Configure required environment variables in `.env`:
   - Edit the `.env` file and set the values according to your setup
   - See `env.example` for detailed descriptions of each variable
   - **Important:** Use strong, unique passwords for production

## 2. Server Setup

### Install Dependencies

```bash
# Install Node.js dependencies
npm install

# Install PM2 globally
npm install -g pm2

# Install Docker and Docker Compose (if not already installed)
# Ubuntu/Debian
sudo apt update
sudo apt install docker.io docker-compose-plugin
sudo systemctl enable docker
sudo systemctl start docker
```

### Database Setup

1. Create a production `docker-compose.prod.yml` file:
```yaml
version: '3.8'
  
services:
  mysql:
    image: mysql:8.0
    container_name: guap-db
    restart: unless-stopped
    env_file:
      - .env
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
      MYSQL_DATABASE: spark_ln_address
      MYSQL_USER: spark_user
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
    ports:
      - "127.0.0.1:3306:3306"  # Bind to localhost only for security
    volumes:
      - guap:/var/lib/mysql
      - ./docker/mysql/init:/docker-entrypoint-initdb.d
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      timeout: 20s
      retries: 10
    command: --default-authentication-plugin=mysql_native_password

volumes:
  guap:
```

2. **Security considerations:**
   - The port binding `127.0.0.1:3306:3306` ensures MySQL is only accessible from localhost
   - Passwords are loaded from `.env` file (make sure it's not committed to version control)
   - Regularly update the MySQL image: `docker pull mysql:8.0`

3. Start MySQL container:
```bash
docker compose -f docker-compose.prod.yml up -d mysql
```

4. Verify MySQL is running:
```bash
docker ps
docker logs guap-db
```

5. **Run Prisma migrations** (you must do this manually):
```bash
npx prisma migrate deploy
```

6. Generate Prisma client:
```bash
npx prisma generate
```

**Note:** For production, you may want to:
- Set up regular backups of the `guap` volume
- Configure MySQL with production-appropriate settings via a custom `my.cnf`

## 3. Build and Deploy

1. Build the application:
```bash
npm run build
```

2. Start with PM2:
```bash
pm2 start ecosystem.config.cjs
```

4. Save PM2 configuration and enable startup:
```bash
pm2 save
pm2 startup
# Follow the output to run the generated sudo command
```

5. Verify the application is running:
```bash
pm2 status
pm2 logs spark-ln-address
```

## 4. NGINX Reverse Proxy

1. Install NGINX and Certbot:
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install nginx certbot python3-certbot-nginx
```

2. Create NGINX configuration (`/etc/nginx/sites-available/yourdomain.com`):
   ```nginx
   server {
     listen 80;
     server_name yourdomain.com;

     location / {
       proxy_pass http://127.0.0.1:3003;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
   }
   ```

3. Enable the site:
   ```bash
   sudo ln -s /etc/nginx/sites-available/yourdomain.com /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl reload nginx
   ```

4. Obtain SSL certificate:
   ```bash
   sudo certbot --nginx -d yourdomain.com
   ```

   Certbot will automatically configure HTTPS and redirect HTTP to HTTPS.

## 5. Verify Deployment

1. Check application health:
   ```bash
   curl http://localhost:3003
   ```

2. Test LNURL endpoint:
   ```bash
   curl https://yourdomain.com/.well-known/lnurlp/testuser
   ```

3. Monitor logs:
   ```bash
   pm2 logs spark-ln-address
   ```

## Maintenance

- **Restart application**: `pm2 restart spark-ln-address`
- **View logs**: `pm2 logs spark-ln-address`
- **Monitor resources**: `pm2 monit`
- **Database migrations**: Run `npx prisma migrate deploy` manually when needed
- **Docker MySQL**:
  - View logs: `docker logs guap-db`
  - Restart: `docker compose -f docker-compose.prod.yml restart mysql`
  - Stop: `docker compose -f docker-compose.prod.yml stop mysql`
  - Backup volume: `docker run --rm -v spark-ln-address_guap:/data -v $(pwd):/backup alpine tar czf /backup/mysql-backup.tar.gz /data`

## Important Notes

- The application must be accessible via HTTPS for LNURL to work properly (LUD-16 requirement)
- Ensure `PUBLIC_BASE_URL` matches your actual domain
- Database migrations must be run manually - do not automate them
- PM2 will automatically restart the application on crashes
- Logs are stored in PM2's default location (typically `~/.pm2/logs/`)
- **Docker MySQL Security**: Ensure MySQL port is bound to `127.0.0.1` only (not `0.0.0.0`) to prevent external access
- **Backups**: Set up regular backups of your MySQL data volume or database

For technical details on how this maps to the LUD-16 specification, see `docs/lnurl-nginx-reverse-proxy.md`.
