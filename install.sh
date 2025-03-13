set -e
export PATH=$PATH:/usr/bin:/bin

# Update system packages and install necessary tools
sudo apt update && sudo apt install -y gcc ipset unzip curl

# Install Node.js and npm via NodeSource (Node.js 18.x)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Print Node.js and npm versions
node_version=$(node -v)
npm_version=$(npm -v)
echo "Node.js $node_version and npm $npm_version have been installed."

# Download and set up api-proxy-nginx repository
wget -q https://github.com/Simon2122/api-proxy-nginx/archive/refs/heads/main.zip -O api-proxy-nginx.zip
unzip -qo api-proxy-nginx.zip && rm api-proxy-nginx.zip
cd api-proxy-nginx-main
npm install

gcc -o relay relay.c -pthread

mv relay /usr/sbin/

# Ask for the new secret key and set it in the .env file
read -p "Enter the new value for SECRET_KEY: " NEW_SECRET_KEY
echo "SECRET_KEY=${NEW_SECRET_KEY}" | sudo tee /root/api-proxy-nginx-main/.env > /dev/null

# Create a systemd service to run the Node.js script automatically
sudo tee /etc/systemd/system/api-proxy.service > /dev/null <<EOL
[Unit]
Description=API Proxy Service
After=network.target

[Service]
ExecStart=/usr/bin/node /root/api-proxy-nginx-main/index.js
Restart=always
WorkingDirectory=/root/api-proxy-nginx-main
StandardOutput=append:/root/api-proxy-nginx-main/run.log
StandardError=append:/root/api-proxy-nginx-main/run.log
User=root
Environment=PATH=/usr/bin:/usr/local/bin
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOL

# Reload systemd to apply the new service
sudo systemctl daemon-reload

# Enable the service to start on boot
sudo systemctl enable api-proxy.service

# Start the service immediately
sudo systemctl start api-proxy.service

# Check the status of the service to confirm it's running
sudo systemctl status api-proxy.service

echo "API Proxy Service has been set up using systemd and is running."
echo "Setup complete."
