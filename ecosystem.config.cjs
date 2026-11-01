module.exports = {
  apps: [
    {
      name: "storageApp",
      script: "bootstrap.js",
      cwd: "/home/ubuntu/storageApp-backend",
      instances: 1,
      exec_mode: "fork",
      env: { NODE_ENV: "production" },
      autorestart: true,
      watch: false,
      max_memory_restart: "500M"
    }
  ]
};
