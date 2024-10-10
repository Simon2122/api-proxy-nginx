require('dotenv').config();
const express = require('express');
const fs = require('fs').promises;
const { exec } = require('child_process');
const { promisify } = require('util');
const app = express();
const port = 8080;
const SECRET_KEY = process.env.SECRET_KEY

const whitelist = new Set([
    "45.90.12.107", // Relais
    "142.59.46.224",  // Home Sim
    "173.177.246.105" // Home Hit
]);

const promisifiedExec = promisify(exec);

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
    await promisifiedExec("/usr/sbin/ipset create whitelist hash:ip -exist");
    await promisifiedExec("/usr/sbin/ipset create server hash:ip -exist");
    const commands = [
        "/usr/sbin/iptables -F",
        "/usr/sbin/iptables -A INPUT -i lo -j ACCEPT",
        ...Array.from(whitelist, ip => `/usr/sbin/iptables -A INPUT -s ${ip} -j ACCEPT`),
        "/usr/sbin/iptables -A INPUT -p udp -m multiport --dports 10000:60000 -m set --match-set whitelist src -j ACCEPT",
        "/usr/sbin/iptables -A INPUT -p tcp -m multiport --dports 10000:60000 -m set --match-set whitelist src -j ACCEPT",
        "/usr/sbin/iptables -A INPUT -p tcp -m multiport --dports 8080 -m set --match-set server src -j ACCEPT",
        "/usr/sbin/iptables -A INPUT -j DROP"
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
        await promisifiedExec(`/usr/sbin/ipset ${operation} whitelist ${ipplayer} -exist`);
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
    const { key, newport, realip, backendport } = req.body;

    if (!key || !newport || !realip || !backendport) {
        return res.status(400).send("ERROR: Missing required parameters\n");
    }
    if (key !== SECRET_KEY) {
        return res.status(403).send('Forbidden');
    }
    const streamConfig = `
        stream {
            upstream backend {
                server ${realip}:${backendport};
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
        await fs.writeFile("/etc/nginx/stream.conf", streamConfig);

        await promisifiedExec("/usr/sbin/ipset flush whitelist");
        await promisifiedExec("systemctl restart nginx");

        await promisifiedExec(`/usr/sbin/ipset add server ${realip} -exist`);
        res.status(200).send(`OK ${newport}\n`);
    } catch (error) {
        console.error(`Error: ${error.message}`);
        res.status(500).send("ERROR\n");
    }
});
app.listen(port, () => {
    firewallInit().catch(error => console.error(`Firewall initialization failed: ${error.message}`));
    console.log(`Proxy API listening on port ${port}`);
});