// Tiny static server for the local copy: the page plus the real frontend files. Port 8080 is the
// port the Worker's CORS list already allows for local development.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = {
  '/': path.join(__dirname, 'index.html'),
  '/css/styles.css': path.join(ROOT, 'frontend/css/styles.css'),
  '/js/app.js': path.join(ROOT, 'frontend/js/app.js')
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

http.createServer((req, res) => {
  const file = FILES[req.url.split('?')[0]];
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)], 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(8080, () => console.log('Dragon\'s Mud (local) page:  http://localhost:8080'));
