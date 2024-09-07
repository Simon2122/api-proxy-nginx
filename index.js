const express = require('express');
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
        "iptables -A INPUT -p udp -m multiport --dports 10000:60000 -j ACCEPT",
        "iptables -A INPUT -p tcp -m multiport --dports 10000:60000 -j ACCEPT",
        "iptables -A INPUT -j DROP"
    ];

    for (const command of commands) {
        await runCommand(command);
    }
}

async function handleIpSetOperation(req, res, operation) {
    const { key, ipplayer } = req.body;
    console.log(key, ipplayer)
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
app.post('/api/ipsetadd', (req, res) => {
    handleIpSetOperation(req, res, 'add')
});
app.post('/api/ipsetdel', (req, res) => {
    handleIpSetOperation(req, res, 'del')
});

app.listen(port, () => {
    firewallInit();
    console.log(`Proxy API listening on port ${port}`);
});

