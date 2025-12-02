module.exports = {
  apps: [
    {
      name: 'spark-ln-address',
      script: 'dist/main.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3003,
      },
      // PM2 will automatically load .env if it exists in the app directory
      // Auto-restart on crash
      autorestart: true,
      // Watch for file changes (disable in production, enable for dev)
      watch: false,
      // Max memory before restart (optional safety measure)
      max_memory_restart: '500M',
      // Logging configuration
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_file: './logs/pm2-combined.log',
      time: true,
      // Merge logs from all instances
      merge_logs: true,
      // Restart delay in ms
      restart_delay: 4000,
      // Max number of restarts within max_restarts time window
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],
}

