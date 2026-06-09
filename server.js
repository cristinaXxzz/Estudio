/**
 * 零依赖的本地静态服务器。运行：node server.js
 * 然后浏览器打开 http://localhost:8460
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8460;
const ROOT = __dirname;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^([.][.][/\\])+/, ''));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 Not Found: ' + urlPath);
            return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log('');
    console.log('  Estudio 已启动 ✓');
    console.log('  浏览器打开：http://localhost:' + PORT);
    console.log('  （关掉这个窗口就停止运行）');
    console.log('');
});
