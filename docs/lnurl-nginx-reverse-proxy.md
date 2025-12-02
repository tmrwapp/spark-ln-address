## NGINX reverse proxy for LNURL (LUD-16)

This document describes how to deploy an NGINX reverse proxy in front of this service so that LNURL wallets can resolve static internet identifiers as specified in [LUD‑16](https://github.com/lnurl/luds/blob/luds/16.md).

The important LNURL endpoint is:

- `GET /.well-known/lnurlp/:username` → handled by `LnurlController` in `src/lnurl/lnurl.controller.ts`

NGINX must expose this path on your public domain and forward it to the NestJS app.

---

### 1. Prerequisites

- A domain name, e.g. `example.com`
- DNS A/AAAA record pointing `example.com` to your server
- This NestJS app running, e.g. on `http://127.0.0.1:3000`
  - `PUBLIC_BASE_URL` **must** be set (e.g. `https://example.com`) so the controller can generate correct callbacks
- NGINX installed on the server

---

### 2. Basic NGINX HTTP reverse proxy (no TLS, for testing)

For local or internal testing you can start with a plain HTTP proxy:

1. Create the NGINX configuration file in `sites-available`:

   ```bash
   sudo nano /etc/nginx/sites-available/lnurl-proxy
   ```

2. Add the following configuration (replace `example.com` with your domain):

   ```nginx
   server {
     listen 80;
     server_name example.com;

     # Forward LNURL pay metadata requests (LUD-16: /.well-known/lnurlp/<username>)
     location /.well-known/lnurlp/ {
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }

     # Forward LNURL callback to NestJS app (`LnurlController.handleLnurlCallback`)
     location /lnurl/callback/ {
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
   }
   ```

3. Create a symlink to enable the site:

   ```bash
   sudo ln -s /etc/nginx/sites-available/lnurl-proxy /etc/nginx/sites-enabled/
   ```

4. Test the configuration and reload NGINX:

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

With this in place, LNURL wallets will call:

- `https://example.com/.well-known/lnurlp/<username>`  
  which NGINX proxies to `http://127.0.0.1:3000/.well-known/lnurlp/<username>` and is handled by `LnurlController.getLnurlPayMetadata`.

The controller then returns a `callback` URL like:

- `https://example.com/lnurl/callback/<username>`

which is again received by NGINX and proxied to the Nest app.

---

### 3. Recommended HTTPS setup with Let's Encrypt

For production you **must** serve LNURL endpoints over HTTPS (as per [LUD‑16](https://github.com/lnurl/luds/blob/luds/16.md)).

Assuming you use Certbot with the NGINX plugin:

1. Install Certbot and the NGINX plugin (OS‑specific).
2. If you haven't already, create a basic HTTP config file in `sites-available`:

   ```bash
   sudo nano /etc/nginx/sites-available/lnurl-proxy
   ```

   Add a basic HTTP server block:

   ```nginx
   server {
     listen 80;
     server_name example.com;

     location /.well-known/lnurlp/ {
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }

     location /lnurl/callback/ {
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
   }
   ```

3. Create a symlink to enable the site:

   ```bash
   sudo ln -s /etc/nginx/sites-available/lnurl-proxy /etc/nginx/sites-enabled/
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
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }

     # LNURL callback endpoint
     location /lnurl/callback/ {
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }

     # (Optional) other app routes
     location / {
       proxy_pass http://127.0.0.1:3000;
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

### 4. How this maps to LUD‑16

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


