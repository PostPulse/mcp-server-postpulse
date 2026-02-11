import axios from 'axios';
import { EventSource } from 'eventsource';

async function testSseConnection() {
    const baseUrl = 'http://localhost:3000';
    console.log(`Running SSE test against ${baseUrl}...`);

    try {
        // 1. Initialize
        console.log('\n1. Sending initialize request (POST /)...');
        // Note: Using dummy auth for local test if verifier allows or if we skip it in test mode
        // For this test, we assume the server is running and might fail auth if no token provided,
        // but we want to see if it reaches the handler.
        const initResponse = await axios.post(`${baseUrl}/`, {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "test-client", version: "1.0.0" }
            }
        }, {
            headers: {
                'Content-Type': 'application/json',
                // Add a dummy token if needed, or rely on local server setup
                'Authorization': `Bearer ${process.env.POSTPULSE_ACCESS_TOKEN || 'dummy'}`
            },
            validateStatus: () => true
        });

        if (initResponse.status !== 200) {
            console.error(`❌ Initialization failed: ${initResponse.status} ${JSON.stringify(initResponse.data)}`);
            return;
        }

        const sessionId = initResponse.headers['mcp-session-id'];
        console.log(`✅ Initialized! Session ID: ${sessionId}`);

        // 2. Connect to SSE
        console.log(`\n2. Connecting to SSE (GET /sse?session_id=${sessionId})...`);
        const es = new EventSource(`${baseUrl}/sse?session_id=${sessionId}`);

        es.onopen = () => {
            console.log('✅ SSE Connection opened!');
            // We can close after successful open for this test
            setTimeout(() => {
                es.close();
                console.log('SSE connection closed by client.');
                process.exit(0);
            }, 2000);
        };

        es.onmessage = (event: any) => {
            console.log(`📩 Received SSE message: ${event.data.substring(0, 100)}...`);
        };

        es.onerror = (err: any) => {
            console.error('❌ SSE Error:', err);
            es.close();
            process.exit(1);
        };

    } catch (error: any) {
        console.error('❌ Test failed:', error.message);
        process.exit(1);
    }
}

testSseConnection();
