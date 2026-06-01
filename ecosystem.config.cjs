module.exports = {
  apps: [
    {
      name: "mimo-claude-proxy",
      script: "proxy.mjs",
      env: {
        MIMO_PROXY_PORT: 3335,
        NODE_ENV: "production",
      },
    },
  ],
};
