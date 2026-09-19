// Site allowlist (was sites.json — Workers can't read local files, so it's a
// module). Keep this list tight: it's what stops someone else pointing their
// own site at your API even if they copy the key out of your page source.
export default {
  sites: {
    localhost: {
      api_key: "sk_live_local_dev_key_12345",
      enabled: true,
      allowed_origins: [
        "http://localhost:4578",
        "http://localhost:8788",
        "https://ghostcloud.ghostos.workers.dev",
      ],
      // Accept any well-known free static host (*.pages.dev, *.workers.dev,
      // *.github.io, *.vercel.app, *.netlify.app, …) so you can spin up a new
      // mirror link without editing this file.
      allow_free_hosts: true,
      allow_all_origins: false,
      max_concurrent_sessions: 15,
      max_session_seconds: 1140, // 19 minutes
      limits: {
        per_minute: 60,
        per_hour: 3600,
        per_day: 86400,
        per_month: 2592000,
      },
    },
  },
};
