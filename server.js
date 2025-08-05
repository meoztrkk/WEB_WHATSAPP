const http = require('http');
const { URL } = require('url');
const { Client, LocalAuth, MessageMedia } = require('./index');
const mime = require('mime');
const fs = require('fs');

const sessions = new Map();

async function cleanupSession(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    try {
        await session.client.destroy();
    } catch (e) {}
    const dir = session.client?.authStrategy?.userDataDir;
    if (dir) {
        try {
            await fs.promises.rm(dir, { recursive: true, force: true });
        } catch (e) {
            console.error(`Failed to remove session data for ${id}: ${e.message}`);
        }
    }
}

function createSession(id) {
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: id })
    });

    const session = { client, ready: false, initializing: true, sending: false };
    sessions.set(id, session);

    client.on('ready', () => {
        session.ready = true;
        session.initializing = false;
        console.log(`Session ${id} is ready`);
    });

    client.on('disconnected', () => {
        console.log(`Session ${id} disconnected`);
        cleanupSession(id);
    });

    client.on('auth_failure', (m) => {
        console.error(`Auth failure for ${id}: ${m}`);
    });

    client.initialize();

    return session;
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 1e7) {
                reject(new Error('Body too large'));
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(e);
            }
        });
    });
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    try {
        if (req.method === 'POST' && url.pathname === '/start-session') {
            const { id } = await parseBody(req);
            if (!id) {
                res.writeHead(400); return res.end('Missing id');
            }
            let session = sessions.get(id);
            if (session) {
                if (session.initializing) {
                    res.writeHead(409); return res.end('Session initialization in progress');
                }
                if (session.ready) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ message: 'Already authenticated' }));
                }
            } else {
                session = createSession(id);
            }

            session.initializing = true;
            const qr = await new Promise((resolve, reject) => {
                const onQr = qr => {
                    session.client.removeListener('ready', onReady);
                    resolve(qr);
                };
                const onReady = () => {
                    session.client.removeListener('qr', onQr);
                    resolve(null);
                };
                session.client.once('qr', onQr);
                session.client.once('ready', onReady);
            });
            session.initializing = false;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (qr) return res.end(JSON.stringify({ qr }));
            return res.end(JSON.stringify({ message: 'Already authenticated' }));
        }

        if (req.method === 'POST' && url.pathname === '/send-message') {
            const { id, to, message, fileName, fileData } = await parseBody(req);
            if (!id || !to || (!message && !fileData)) {
                res.writeHead(400); return res.end('Missing fields');
            }
            const session = sessions.get(id);
            if (!session || !session.ready) {
                res.writeHead(404); return res.end('Session not found');
            }
            if (session.sending) {
                res.writeHead(409); return res.end('Another message is being sent');
            }
            session.sending = true;
            try {
                if (fileName && fileData) {
                    const mimetype = mime.getType(fileName) || 'application/octet-stream';
                    const media = new MessageMedia(mimetype, fileData, fileName);
                    await session.client.sendMessage(to, media, { caption: message });
                } else {
                    await session.client.sendMessage(to, message);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'sent' }));
            } catch (e) {
                res.writeHead(500); res.end(e.message);
            } finally {
                session.sending = false;
            }
            return;
        }

        if (req.method === 'POST' && url.pathname === '/logout') {
            const { id } = await parseBody(req);
            if (!id) { res.writeHead(400); return res.end('Missing id'); }
            const session = sessions.get(id);
            if (!session) { res.writeHead(404); return res.end('Session not found'); }
            await cleanupSession(id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'logged out' }));
        }

        res.writeHead(404); res.end('Not found');
    } catch (e) {
        res.writeHead(500); res.end(e.message);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
