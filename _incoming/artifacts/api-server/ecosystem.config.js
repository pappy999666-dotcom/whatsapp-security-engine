module.exports = {
    apps: [{
        name: 'pappy-bot',
        script: 'index.js',
        node_args: '--expose-gc',
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: '1G',
        restart_delay: 5000,
        env: {
            NODE_ENV: 'production',
        },
        error_file: 'data/logs/pm2-err.log',
        out_file: 'data/logs/pm2-out.log',
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
    }],
};
