/**
 * PM2 ecosystem — Cortex worker + Pipeline Sentinel.
 *
 * Launch:  pm2 start ecosystem.config.cjs
 * Status:  pm2 status
 * Logs:    pm2 logs
 *
 * Note: package.json has "type": "module", so this file uses .cjs (CommonJS).
 * Web/ingress nodes should still set GENERATION_QUEUE_WORKER=external|0 so
 * only the dedicated worker process drains the queue.
 */

module.exports = {
  apps: [
    {
      name: "cortex-generation-worker",
      script: "npm",
      args: "run worker:generation",
      env: {
        NODE_ENV: "production",
        GENERATION_QUEUE_WORKER: "external",
      },
      restart_delay: 3000,
      max_restarts: 10,
      autorestart: true,
      watch: false,
    },
    {
      name: "pipeline-sentinel-bot",
      script: "npm",
      args: "run sentinel:daemon",
      env: {
        NODE_ENV: "production",
      },
      restart_delay: 5000,
      max_restarts: 10,
      autorestart: true,
      watch: false,
    },
  ],
};
