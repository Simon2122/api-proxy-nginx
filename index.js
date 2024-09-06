const express = require('express');
const fs = require('fs');
const { exec } = require('child_process');
const app = express();
const port = 8080;
const SECRET_KEY = 'afterlife897787';

app.use(express.json());

app.post('/api/proxy/change/port', (req, res) => {
    const { APIKEY, realip, realport } = req.body;

    if (!realip || !realport || !APIKEY) {
        return res.status(400).json({ error: 'Invalid Request' });
    }
    if (SECRET_KEY !== APIKEY) {
        return res.status(403).json({ error: 'Forbiden' });
    }

    const nginxConfPath = '/etc/nginx/nginx.conf';
    const streamConfPath = '/etc/nginx/stream.conf';

    try {
        // Read and update nginx.conf
        let nginxConf = fs.readFileSync(nginxConfPath, 'utf8');
        const upstreamPattern = /server\s+([0-9\.]+):([0-9]+)/g;
        nginxConf = nginxConf.replace(upstreamPattern, `server ${realip}:${realport}`);
        fs.writeFileSync(nginxConfPath, nginxConf, 'utf8');

        // Read and update stream.conf (if applicable)
        let streamConf = fs.readFileSync(streamConfPath, 'utf8');
        streamConf = streamConf.replace(upstreamPattern, `server ${realip}:${realport}`);
        fs.writeFileSync(streamConfPath, streamConf, 'utf8');

        // Reload Nginx to apply changes
        exec('sudo systemctl restart nginx', (error, stdout, stderr) => {
            if (error) {
                console.error(`Error reloading Nginx: ${stderr}`);
                return res.status(500).json({ error: 'Failed to reload Nginx' });
            }

            // Respond with success
            res.status(200).json({ message: 'Configuration updated successfully' });
        });

    } catch (error) {
        console.error('Error updating configuration:', error);
        res.status(500).json({ error: 'Failed to update configuration' });
    }
});
app.post('/api/ipsetadd', (req, res) => {
    const { key, ipplayer } = req.body;

    if (!key || !ipplayer) {
        return res.status(400).send('Invalid Request');
    }
    if (key !== SECRET_KEY) {
        return res.status(403).send('Forbidden');
    }

    exec(`sudo ipset add whitelist ${ipplayer}`, (error, stdout, stderr) => {
        if (error) {
            return res.status(500).send(`Error adding IP to ipset: ${stderr}`);
        }

        res.status(200).send('IP added to whitelist');
    });
});
app.post('/api/ipsetdel', (req, res) => {
    const { key, ipplayer } = req.body;

    if (!key || !ipplayer) {
        return res.status(400).send('Invalid Request');
    }
    if (key !== SECRET_KEY) {
        return res.status(403).send('Forbidden');
    }

    exec(`sudo ipset del whitelist ${ipplayer}`, (error, stdout, stderr) => {
        if (error) {
            return res.status(500).send(`Error removing IP from ipset: ${stderr}`);
        }

        res.status(200).send('IP removed from whitelist');
    });
});


app.listen(port, () => {
    console.log(`Proxy API listening on port ${port}`);
});