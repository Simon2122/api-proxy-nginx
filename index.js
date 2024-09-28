const express = require('express');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const app = express();
const port = 8080;
const SECRET_KEY = 'afterlife897787';

const whitelist = new Set([
    "148.113.201.29", // Load Balancer
    "142.59.46.224"  // Home
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
        await promisifiedExec(`ipset ${operation} whitelist ${ipplayer} -exist`);
        console.log(`IPSet ${operation}ed: ${ipplayer}`);
        res.status(200).send('OK\n');
    } catch (error) {
        console.log(`Error: ${error.message}`);
    }
}

app.use(express.json());
app.post('/api/ipsetadd', (req, res) => handleIpSetOperation(req, res, 'add'));
app.post('/api/ipsetdel', (req, res) => handleIpSetOperation(req, res, 'del'));

app.post('/api/proxy/change/port', async (req, res) => {
    const { key, newport, realip } = req.body;

    if (!key || !newport || !realip) {
        return res.status(400).send("ERROR: Missing required parameters\n");
    }
    if (key !== SECRET_KEY) {
        return res.status(403).send('Forbidden');
    }
    const streamConfig = `
        stream {
            upstream backend {
                server ${realip}:30120;
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
        await promisifiedWriteFile("/etc/nginx/stream.conf", streamConfig);

        await promisifiedExec("ipset flush whitelist");
        await promisifiedExec("systemctl restart nginx");

        await promisifiedExec(`ipset add whitelist ${realip} -exist`);
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
