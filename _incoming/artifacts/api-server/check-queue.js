// Check queue status
const { Queue } = require('bullmq');
const config = require('./config');

const bullConfig = {
    connection: { 
        host: config.redis.host, 
        port: config.redis.port, 
        password: config.redis.password || undefined,
        maxRetriesPerRequest: null 
    }
};

async function checkQueues() {
    try {
        // Try to find all queue names
        const queueNames = ['elite-broadcast-NODE_*-status', 'elite-broadcast-*'];
        
        console.log('Checking Bull queues...\n');
        
        for (const pattern of queueNames) {
            try {
                const queue = new Queue(pattern, bullConfig);
                const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
                console.log(`Queue: ${pattern}`);
                console.log(`  Waiting: ${counts.waiting}`);
                console.log(`  Active: ${counts.active}`);
                console.log(`  Failed: ${counts.failed}`);
                console.log(`  Completed: ${counts.completed}\n`);
                await queue.close();
            } catch (err) {
                console.log(`Could not check ${pattern}: ${err.message}`);
            }
        }
        
        process.exit(0);
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

checkQueues();
