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

const IsIpv4 = (ip) => /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?).(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?).(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?).(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ip);


async function firewallInit() {
    const commands = [
        // Flush existing iptables rules to start with a clean slate
        "/usr/sbin/iptables -F",

        // Create the necessary ipsets if they don't already exist
        "/usr/sbin/ipset create whitelist hash:ip -exist",  // IPs allowed to connect to the port range
        "/usr/sbin/ipset create server hash:ip -exist",     // IPs allowed to connect to port 8080

        // Accept all traffic on the loopback interface
        "/usr/sbin/iptables -A INPUT -i lo -j ACCEPT",

        // Allow related and established connections (keep track of ongoing connections)
        "/usr/sbin/iptables -A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",

        // Allow ICMP traffic
        "/usr/sbin/iptables -A INPUT -p icmp -j ACCEPT",
        
        // Allow traffic from whitelisted IPs to any port
        ...Array.from(whitelist, ip => `/usr/sbin/iptables -A INPUT -s ${ip} -j ACCEPT`),

        // Allow TCP traffic on port 8080 for IPs in the "server" IP set
        "/usr/sbin/iptables -A INPUT -p tcp --dport 8080 -m set --match-set server src -j ACCEPT",

        // Allow UDP traffic on port range 10000-60000 for IPs in the "whitelist" IP set without hitting the limit
        "/usr/sbin/iptables -A INPUT -p udp -m multiport --dports 10000:60000 -m set --match-set whitelist src -j ACCEPT",

        // Limit UDP traffic on port range 10000-60000 for IPs in the "whitelist" IP set to 1 Mbps per IP
        "/usr/sbin/iptables -A INPUT -p udp -m multiport --dports 10000:60000 -m set --match-set whitelist src -m hashlimit --hashlimit-name udp_limit --hashlimit-above 1mbit/sec --hashlimit-mode srcip --hashlimit-htable-expire 10000 -j DROP",

        // SYN flood protection: Limit SYN packets per IP
        "/usr/sbin/iptables -A INPUT -p tcp --syn -m connlimit --connlimit-above 16 -j DROP",

        // Set up a tracking mechanism for new TCP connections on the port range 10000-60000 for whitelisted IPs
        "/usr/sbin/iptables -A INPUT -p tcp -m multiport --dports 10000:60000 -m set --match-set whitelist src -m state --state NEW -m recent --set",

        // Allow remaining TCP connections within the limit
        "/usr/sbin/iptables -A INPUT -p tcp -m multiport --dports 10000:60000 -m set --match-set whitelist src -j ACCEPT",

        // Limit new TCP connections on the port range 10000-60000 for whitelisted IPs to 15 per minute
        "/usr/sbin/iptables -A INPUT -p tcp -m multiport --dports 10000:60000 -m set --match-set whitelist src -m state --state NEW -m recent --update --seconds 60 --hitcount 15 -j DROP",

        // Log and reject any packet not matching the rules above (optional for debugging)
        "/usr/sbin/iptables -A INPUT -j LOG --log-prefix 'iptables-reject: ' --log-level 4",

        // Drop all other traffic
        "/usr/sbin/iptables -A INPUT -j DROP"
    ];

    try {
        for (const command of commands) {
            try {
                const { stdout, stderr } = await promisifiedExec(command);
                console.log(`Command '${command}' executed successfully.`);
                if (stderr) {
                    console.error(`Warning in command '${command}': ${stderr}`);
                }
            } catch (cmdError) {
                console.error(`Error executing command '${command}': ${cmdError}`);
            }
        }
    } catch (error) {
        console.error(`Unexpected error during firewall initialization: ${error}`);
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
    if (!IsIpv4(realip)) {
        return res.status(400).send("Invalid real IP");
    }

    if (isNaN(backendport) || backendport < 1 || backendport > 65535) {
        return res.status(400).send("Invalid backend port");
    }
    if (isNaN(newport) || newport < 10000 || newport > 60000) {
        return res.status(400).send("Invalid new port");
    }
    
    const streamConfig = `
    stream {
        upstream backend {
            server ${realip}:${backendport};
        }
        server {
		    listen ${newport};
		    proxy_pass backend;
	    }
        server {
            listen ${newport} udp reuseport;
            proxy_pass backend;
        }
    }
    `;
    try {
        await fs.writeFile("/etc/nginx/stream.conf", streamConfig);

        await promisifiedExec("/usr/sbin/ipset flush server");
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
    try {
        firewallInit(); // Ensure this function is called
        console.log(`Proxy API listening on port ${port}`);
    } catch (error) {
        console.error(`Firewall initialization failed: ${error.message}`);
    }
});