# Production Installation Guide

## Prerequisites

- Node.js 24.22.1 or newer within the Node 24 LTS line (`>=24.22.1 <25`)
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

Install and select the runtime pinned in `.nvmrc`. For example, with `nvm`:

```bash
nvm install
nvm use
node --version # must report v24.22.1 or a newer v24 release
```

Then install the locked dependencies and PM2:

```bash
# Install Node.js dependencies exactly as locked
npm ci

# Install PM2 globally for the selected Node runtime
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

2. Start with PM2 from the selected Node 24 environment:
```bash
pm2 start ecosystem.config.cjs
pm2 show spark-ln-address
```

   Confirm that PM2 reports a Node version satisfying `>=24.22.1 <25`. The production configuration has `watch: false`, so future deployments require an explicit `pm2 restart spark-ln-address --update-env` after building.

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

### Updating the Node runtime

When `.nvmrc` changes, migrate both the application process and the PM2 daemon to the pinned runtime:

```bash
nvm install
nvm use
node --version
npm ci
npx prisma generate
npm run build
npx prisma migrate deploy
npm install -g pm2
pm2 update
pm2 restart spark-ln-address --update-env
pm2 save
pm2 show spark-ln-address
```

If PM2 startup was configured through a version-manager path, regenerate the startup service with `pm2 unstartup` followed by `pm2 startup`, then run the generated privileged command and `pm2 save`.

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
