## NGINX reverse proxy for LNURL (LUD-16)

This document describes how to deploy an NGINX reverse proxy in front of this service so that LNURL wallets can resolve static internet identifiers as specified in [LUD‑16](https://github.com/lnurl/luds/blob/luds/16.md).

The important LNURL endpoint is:

- `GET /.well-known/lnurlp/:username` → handled by `LnurlController` in `src/lnurl/lnurl.controller.ts`

NGINX must expose this path on your public domain and forward it to the NestJS app.

---

### 1. Running the application with PM2

Before setting up NGINX, you need to have the NestJS application running. PM2 is recommended for production deployments as it provides process management, auto-restart, and logging.

#### Prerequisites

- Node.js and npm installed
- PM2 installed globally: `npm install -g pm2`
- Application dependencies installed: `npm install`
- Database configured and accessible
- Environment variables configured (see `env.example`)

#### Deployment steps

1. Build the application:

   ```bash
   npm run build
   ```

2. Create a `.env` file in the project root with your configuration:

   ```bash
   cp env.example .env
   # Edit .env with your actual values
   ```

   Required variables:
   - `DATABASE_URL` - MySQL connection string
   - `PUBLIC_BASE_URL` - Your public domain (e.g. `https://example.com`)
   - `LIGHTSPARK_CLIENT_ID` - Lightspark client ID
   - `LIGHTSPARK_CLIENT_SECRET` - Lightspark client secret
   - `LIGHTSPARK_NODE_ID` - Lightspark node ID
   - `PORT` - Port to run on (default: 3003)

3. Create logs directory (PM2 will write logs here):

   ```bash
   mkdir -p logs
   ```

4. Start the application with PM2:

   ```bash
   pm2 start ecosystem.config.cjs
   ```

5. Save PM2 process list to start on system reboot:

   ```bash
   pm2 save
   pm2 startup
   ```

   The `pm2 startup` command will output a command to run with `sudo` that sets up PM2 to start on boot.

6. Verify the application is running:

   ```bash
   pm2 status
   pm2 logs spark-ln-address
   ```

7. The application should now be running on `http://127.0.0.1:3003` (or your configured `PORT`).

#### Useful PM2 commands

- `pm2 restart spark-ln-address` - Restart the application
- `pm2 stop spark-ln-address` - Stop the application
- `pm2 delete spark-ln-address` - Remove from PM2
- `pm2 logs spark-ln-address` - View logs
- `pm2 monit` - Monitor resources (CPU, memory)

**Note:** Make sure the port in your NGINX configuration matches the `PORT` environment variable (default is 3003, not 3000).

---

### 2. Prerequisites for NGINX setup

- A domain name, e.g. `example.com`
- DNS A/AAAA record pointing `example.com` to your server
- This NestJS app running via PM2 (see section 1), e.g. on `http://127.0.0.1:3003`
  - `PUBLIC_BASE_URL` **must** be set (e.g. `https://example.com`) so the controller can generate correct callbacks
- NGINX installed on the server

---

### 3. Basic NGINX HTTP reverse proxy (no TLS, for testing)

For local or internal testing you can start with a plain HTTP proxy:

1. Create the NGINX configuration file in `sites-available`:

   ```bash
   sudo nano /etc/nginx/sites-available/example.com
   ```

2. Add the following configuration (replace `example.com` with your domain):

   ```nginx
   server {
     listen 80;
     server_name example.com;

     # Forward all API calls to NestJS app
     location / {
       proxy_pass http://127.0.0.1:3003;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
   }
   ```

3. Create a symlink to enable the site:

   ```bash
   sudo ln -s /etc/nginx/sites-available/example.com /etc/nginx/sites-enabled/
   ```

4. Test the configuration and reload NGINX:

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

With this in place, LNURL wallets will call:

- `https://example.com/.well-known/lnurlp/<username>`  
  which NGINX proxies to `http://127.0.0.1:3003/.well-known/lnurlp/<username>` and is handled by `LnurlController.getLnurlPayMetadata`.

The controller then returns a `callback` URL like:

- `https://example.com/lnurl/callback/<username>`

which is again received by NGINX and proxied to the Nest app.

---

### 4. Recommended HTTPS setup with Let's Encrypt

For production you **must** serve LNURL endpoints over HTTPS (as per [LUD‑16](https://github.com/lnurl/luds/blob/luds/16.md)).

Assuming you use Certbot with the NGINX plugin:

1. Install Certbot and the NGINX plugin (OS‑specific).
2. If you haven't already, create a basic HTTP config file in `sites-available`:

   ```bash
   sudo nano /etc/nginx/sites-available/example.com
   ```

   Add a basic HTTP server block:

   ```nginx
   server {
     listen 80;
     server_name example.com;

     location /.well-known/lnurlp/ {
       proxy_pass http://127.0.0.1:3003;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }

     location /lnurl/callback/ {
       proxy_pass http://127.0.0.1:3003;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
   }
   ```

3. Create a symlink to enable the site:

   ```bash
   sudo ln -s /etc/nginx/sites-available/example.com /etc/nginx/sites-enabled/
   ```

4. Test and reload NGINX:

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

5. Run Certbot to obtain SSL certificates:

   ```bash
   sudo certbot --nginx -d example.com
   ```

6. Certbot will automatically modify your config file and create an HTTPS server block similar to:

   ```nginx
   server {
     listen 443 ssl;
     server_name example.com;

     ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
     ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

     # LNURL pay metadata endpoint
     location /.well-known/lnurlp/ {
       proxy_pass http://127.0.0.1:3003;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }

     # LNURL callback endpoint
     location /lnurl/callback/ {
       proxy_pass http://127.0.0.1:3003;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }

     # (Optional) other app routes
     location / {
       proxy_pass http://127.0.0.1:3003;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
   }

   server {
     listen 80;
     server_name example.com;

     # Redirect all HTTP to HTTPS
     return 301 https://$host$request_uri;
   }
   ```

7. Certbot will automatically test and reload NGINX, but you can verify:

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

8. Make sure your `.env` (or environment) sets:

   ```bash
   PUBLIC_BASE_URL=https://example.com
   ```

   so that `LnurlController` generates LNURL callbacks with the correct domain.

---

### 5. How this maps to LUD‑16

Per [LUD‑16](https://github.com/lnurl/luds/blob/luds/16.md), a wallet resolving an internet identifier like:

- `alice@example.com`

must call:

- `https://example.com/.well-known/lnurlp/alice`

In this project:

- NGINX receives that request and proxies it to the NestJS app
- `LnurlController.getLnurlPayMetadata` returns a `payRequest` response (LUD‑06) with:
  - `callback` → `https://example.com/lnurl/callback/alice`
  - `minSendable` / `maxSendable`
  - `metadata` including identifier info (e.g. `alice@example.com`)
- The wallet then calls `callback` with `amount=<msat>`, which NGINX again forwards to the app (`LnurlController.handleLnurlCallback`), completing the LNURL‑pay flow.


