require('dotenv').config();
const express = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');
const spawn = require('child_process').spawn;
const app = express();
const port = 8080;
const SECRET_KEY = process.env.SECRET_KEY;
const promisifiedExec = promisify(exec);

const whitelist = new Set([
    "148.113.196.69", // Relais
    "75.152.35.18",  // Home Sim
    "173.177.246.105" // Home Hit
]);

const IsIpv4 = (ip) => /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?).(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?).(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?).(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ip);

const restrictToAllowedIP = (req, res, next) => {
    if (!whitelist.has(req.ip.replace('::ffff:', ''))) {
        return res.status(403).send('Forbidden: Access restricted to the allowed IP.');
    }
    next();
};

async function firewallInit() {
    const commands = [
        "/usr/sbin/iptables -F", // Flush existing iptables rules
        "/usr/sbin/ipset create whitelist hash:ip -exist",
        "/usr/sbin/iptables -A INPUT -i lo -j ACCEPT",
        "/usr/sbin/iptables -A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
        "/usr/sbin/iptables -A INPUT -p icmp -j ACCEPT",
        ...Array.from(whitelist, ip => `/usr/sbin/iptables -A INPUT -s ${ip} -j ACCEPT`),
        `/usr/sbin/iptables -A INPUT -p tcp --dport 10000:60000 -m set --match-set whitelist src -j ACCEPT`,
        `/usr/sbin/iptables -A INPUT -p udp --dport 10000:60000 -m set --match-set whitelist src -j ACCEPT`,
        "/usr/sbin/iptables -A INPUT -j LOG --log-prefix 'iptables-reject: ' --log-level 4",
        "/usr/sbin/iptables -A INPUT -p tcp --syn -m connlimit --connlimit-above 16 -j DROP",
        "/usr/sbin/iptables -A INPUT -j DROP"
    ];

    for (const command of commands) {
        await promisifiedExec(command).catch((error) =>
            console.error(`Error with command '${command}': ${error.message}`)
        );
    }
    console.log("Base firewall initialized");
}

async function handlePortChange(req, res) {
    const { key, newport, realip, backendport } = req.body;
    
    if (!key || !newport || !realip || !backendport) {
        return res.status(400).send("ERROR: Missing required parameters\n");
    }
    if (key !== SECRET_KEY) {
        return res.status(403).send('Forbidden');
    }
    if (!IsIpv4(realip)) {
        return res.status(400).send("Invalid real IP");
    }
    if (isNaN(backendport) || backendport < 1 || backendport > 65535) {
        return res.status(400).send("Invalid backend port");
    }
    if (isNaN(newport) || newport < 10000 || newport > 60000) {
        return res.status(400).send("Invalid new port");
    }

    try {
        await promisifiedExec('killall -9 relay || true');
        const child = spawn('/usr/sbin/relay', ['-l', newport, '-r', realip, backendport, '-T', '10'], {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
        await promisifiedExec(`/usr/sbin/ipset flush whitelist`);
        res.status(200).send(`OK ${newport}\n`);
    } catch (error) {
        console.error(`Error: ${error.message}`);
        res.status(500).send("ERROR\n");
    }
}
async function handleIpSetOperation(req, res, operation) {
    const { key, ipplayer } = req.body;
    if (!key || !ipplayer) {
        return res.status(400).send('Invalid Request');
    }
    if (!IsIpv4(ipplayer)) {
        return res.status(400).send('Invalid Request');
    }
    if (!['add', 'del'].includes(operation)) {
        return res.status(400).send('Invalid Operation');
    }
    if (key !== SECRET_KEY) {
        return res.status(403).send('Forbidden');
    }
    try {
        await promisifiedExec(`/usr/sbin/ipset ${operation} whitelist ${ipplayer} -exist`);
        console.log(`IPSet ${operation}ed: ${ipplayer}`);
        res.status(200).send('OK\n');
    } catch (error) {
        res.status(500).send(`Server Error: ${error.message}`);
        console.log(`Error: ${error.message}`);
    }
}

app.use(express.json());
app.post('/api/ipsetadd', restrictToAllowedIP, (req, res) => handleIpSetOperation(req, res, 'add'));
app.post('/api/ipsetdel', restrictToAllowedIP, (req, res) => handleIpSetOperation(req, res, 'del'));
app.post('/api/proxy/change/port', restrictToAllowedIP, handlePortChange);

app.listen(port, async () => {
    await firewallInit(); // Initialize base firewall on startup
    console.log(`Proxy API listening on port ${port}`);
});