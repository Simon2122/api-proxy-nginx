const express = require('express');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const app = express();
const port = 8080;
const SECRET_KEY = 'afterlife897787';

const whitelist = new Set([
    "148.113.173.203", // Load Balancer
    "15.235.119.145",  // Server Live
    "173.177.246.105"  // Home
]);

const promisifiedExec = promisify(exec);
const promisifiedWriteFile = promisify(fs.writeFile);

async function runCommand(command) {
    try {
        const { stdout, stderr } = await promisifiedExec(command);
        if (stderr) {
            console.error(`Error executing command '${command}': ${stderr}`);
        } else {
            console.log(`Executed: ${command}`);
        }
    } catch (error) {
        console.error(`Execution error: ${error.message}`);
    }
}

async function firewallInit() {
    const commands = [
        "iptables -F",
        "iptables -A INPUT -i lo -j ACCEPT",
        ...Array.from(whitelist, ip => `iptables -A INPUT -s ${ip} -j ACCEPT`),
        "iptables -A INPUT -p udp -m multiport --dports 10000:60000 -m set --match-set whitelist src -j ACCEPT",
        "iptables -A INPUT -p tcp -m multiport --dports 10000:60000 -m set --match-set whitelist src -j ACCEPT",
        "iptables -A INPUT -j DROP"
    ];

    for (const command of commands) {
        await runCommand(command);
    }
}

async function handleIpSetOperation(req, res, operation) {
    const { key, ipplayer } = req.body;

    if (!key || !ipplayer) {
        return res.status(400).send('Invalid Request');
    }
    if (key !== SECRET_KEY) {
        return res.status(403).send('Forbidden');
    }

    try {
        await promisifiedExec(`sudo ipset ${operation} whitelist ${ipplayer}`);
        res.status(200).send(`IP ${operation === 'add' ? 'added to' : 'removed from'} whitelist`);
    } catch (error) {
        res.status(500).send(`Error ${operation === 'add' ? 'adding' : 'removing'} IP from ipset: ${error.message}`);
    }
}

app.use(express.json());

app.post('/api/ipsetadd', (req, res) => handleIpSetOperation(req, res, 'add'));
app.post('/api/ipsetdel', (req, res) => handleIpSetOperation(req, res, 'del'));

app.post('/api/proxy/change/port', async (req, res) => {
    const { key, newport, realip, realport } = req.body;

    if (![key, newport, myip, connectport, loadbalancer, domainname, realip, realport].every(Boolean)) {
        return res.status(400).send("ERROR: Missing required parameters\n");
    }
    if (key !== SECRET_KEY) {
        return res.status(403).send('Forbidden');
    }

    const nginxConfig = `
        user www-data;
        worker_processes auto;
        error_log  /var/log/nginx/error.log notice;
        pid /run/nginx.pid;
        include /etc/nginx/modules-enabled/*.conf;

        worker_rlimit_nofile 65535;

        events {
            worker_connections 65535;
            multi_accept on;
        }

        http {
            include       /etc/nginx/mime.types;
            default_type  application/octet-stream;
            ssl_protocols TLSv1.2;
            log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '
                            '$status $body_bytes_sent "$http_referer" '
                            '"$http_user_agent" "$http_x_forwarded_for"';

            access_log  /var/log/nginx/access.log  main;

            keepalive_timeout 65;
            sendfile on;
            tcp_nopush on;
            tcp_nodelay on;
            types_hash_max_size 2048;
        }

        include /etc/nginx/stream.conf;
    `;

    const streamConfig = `
        stream {
            upstream backend {
                server ${realip}:${realport};
            }
            server {
                listen ${newport};
                proxy_socket_keepalive on;
                proxy_pass backend;
            }
            server {
                listen ${newport} udp reuseport;
                proxy_socket_keepalive on;
                proxy_pass backend;
            }
        }
    `;

    try {
        await promisifiedWriteFile("/etc/nginx/nginx.conf", nginxConfig);
        await promisifiedWriteFile("/etc/nginx/stream.conf", streamConfig);

        await promisifiedExec("sudo ipset flush whitelist");
        await promisifiedExec("sudo systemctl restart nginx");

        res.status(200).send(`OK ${newport}\n`);
    } catch (error) {
        console.error(`Error: ${error.message}`);
        res.status(500).send("ERROR\n");
    }
});

app.listen(port, () => {
    firewallInit();
    console.log(`Proxy API listening on port ${port}`);
});
