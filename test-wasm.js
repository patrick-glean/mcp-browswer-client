const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const http = require('http');

// MIME type mapping
const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.ico': 'image/x-icon'
};

// Start a local server to serve the files
const server = http.createServer((req, res) => {
    const url = req.url === '/' ? '/index.html' : req.url;
    const filePath = path.join(__dirname, 'public', url);
    const extname = path.extname(filePath);
    const contentType = MIME_TYPES[extname] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            console.error(`Error reading file ${filePath}:`, err);
            res.writeHead(404);
            res.end('File not found');
            return;
        }

        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

async function testWasmLoading() {
    console.log('Starting WASM module test...');
    
    // Start the server
    const port = 8080;
    await new Promise((resolve) => server.listen(port, resolve));
    console.log(`Server running at http://localhost:${port}`);
    
    let browser;
    try {
        // Start browser with more stable configuration
        browser = await puppeteer.launch({
            headless: 'new',
            executablePath: process.platform === 'darwin' 
                ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
                : undefined,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-extensions'
            ],
            ignoreHTTPSErrors: true,
            timeout: 0
        });
        
        // Create a new page with more stable configuration
        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(0);
        await page.setDefaultTimeout(0);
        
        // Enable console logging
        page.on('console', msg => {
            const text = msg.text();
            if (text.includes('JSHandle@object')) {
                // For object messages, try to get the actual content
                msg.args().forEach(async (arg) => {
                    try {
                        const value = await arg.jsonValue();
                        console.log('Browser console object:', JSON.stringify(value, null, 2));
                    } catch (e) {
                        console.log('Browser console:', text);
                    }
                });
            } else {
                console.log('Browser console:', text);
            }
        });
        
        // Enable request logging
        page.on('request', request => {
            console.log('Request:', request.url());
        });
        
        page.on('requestfailed', request => {
            console.log('Request failed:', request.url(), request.failure().errorText);
        });
        
        // Load the page
        console.log('Loading page...');
        await page.goto(`http://localhost:${port}`, {
            waitUntil: ['networkidle0', 'domcontentloaded'],
            timeout: 0
        });
        
        // Wait for service worker to be ready
        console.log('Waiting for service worker...');
        await page.waitForFunction(() => navigator.serviceWorker.controller !== null, {
            timeout: 0
        });
        console.log('Service worker is ready');
        
        // Test WASM module loading
        console.log('Testing WASM module loading...');
        await page.evaluate(() => {
            return new Promise((resolve) => {
                navigator.serviceWorker.controller.postMessage({ type: 'reload_wasm' });
                navigator.serviceWorker.addEventListener('message', function handler(event) {
                    if (event.data.type === 'wasm_status') {
                        navigator.serviceWorker.removeEventListener('message', handler);
                        resolve(event.data.healthy);
                    }
                });
            });
        }).then(healthy => {
            if (healthy) {
                console.log('✅ WASM module loaded successfully');
            } else {
                console.log('❌ WASM module failed to load:', null);
            }
        });
        
        // Test WASM check functionality
        console.log('Testing WASM check functionality...');
        await page.evaluate(() => {
            return new Promise((resolve) => {
                navigator.serviceWorker.controller.postMessage({ type: 'check_wasm' });
                navigator.serviceWorker.addEventListener('message', function handler(event) {
                    if (event.data.type === 'wasm_status') {
                        navigator.serviceWorker.removeEventListener('message', handler);
                        resolve(event.data.healthy);
                    }
                });
            });
        }).then(healthy => {
            if (healthy) {
                console.log('✅ WASM check passed');
            } else {
                console.log('❌ WASM check failed');
            }
        });
        
        // Get logs from the page
        const logs = await page.evaluate(() => {
            const logContainer = document.getElementById('log-container');
            return logContainer ? logContainer.innerText : 'No logs found';
        });
        
        console.log('\nLogs from the page:');
        console.log(logs);
        
    } catch (error) {
        console.error('Test failed:', error);
        if (error.stack) {
            console.error('Stack trace:', error.stack);
        }
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch (e) {
                console.error('Error closing browser:', e);
            }
        }
        server.close();
    }
}

// Run the test
testWasmLoading().catch(error => {
    console.error('Fatal error:', error);
    if (error.stack) {
        console.error('Stack trace:', error.stack);
    }
    process.exit(1);
}); 