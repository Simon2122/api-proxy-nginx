set -e
export PATH=$PATH:/usr/bin:/bin
# Update system packages and install necessary tools
sudo apt update && sudo apt install -y nginx-full ipset nodejs unzip curl cron

# Backup existing NGINX configuration file if not already backed up
if [ ! -f /etc/nginx/nginx.conf.backup ]; then
  sudo cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.backup
  echo "Backed up nginx.conf to nginx.conf.backup."
fi

# Create the nginx.conf file with the specified configurations
sudo tee /etc/nginx/nginx.conf > /dev/null <<EOL
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
    log_format  main  '\$remote_addr - \$remote_user [\$time_local] "\$request" '
                    '\$status \$body_bytes_sent "\$http_referer" '
                    '"\$http_user_agent" "\$http_x_forwarded_for"';

    access_log  /var/log/nginx/access.log  main;

    keepalive_timeout 65;
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    types_hash_max_size 2048;
}

include /etc/nginx/stream.conf;
EOL

# Create stream.conf file
sudo tee /etc/nginx/stream.conf > /dev/null <<EOL
stream {
    upstream backend {
        server 51.161.34.239:30120;
    }
    server {
        listen 36196;
        proxy_socket_keepalive on;
        proxy_pass backend;
    }
    server {
        listen 36196 udp reuseport;
        proxy_socket_keepalive on;
        proxy_pass backend;
    }
}
EOL

# Start and enable NGINX
sudo systemctl restart nginx
echo "NGINX has been installed and configured."

# Install Node.js (LTS version from NodeSource)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
sudo apt install -y npm

# Print Node.js version
node_version=$(node -v)
npm_version=$(npm -v)
echo "Node.js $node_version and npm $npm_version have been installed."

# Download and set up api-proxy-nginx repository
wget -q https://github.com/Simon2122/api-proxy-nginx/archive/refs/heads/main.zip -O api-proxy-nginx.zip
unzip -qo api-proxy-nginx.zip && rm api-proxy-nginx.zip
cd api-proxy-nginx-main
npm install

read -p "Enter the new value for SECRET_KEY: " NEW_SECRET_KEY
echo "SECRET_KEY=${NEW_SECRET_KEY}" | sudo tee /root/api-proxy-nginx-main/.env > /dev/null

# Run the API Proxy in the background and redirect output to run.log
node index.js > run.log 2>&1 &

# Add cron job to check if the script is running, and restart if not
(crontab -l 2>/dev/null; echo "* * * * * pgrep -f 'node index.js' > /dev/null || (cd /api-proxy-nginx-main && node index.js > run.log 2>&1 &)") | crontab -

echo "API Proxy has been set up and is running in the background. Cron job added to restart if the process crashes."

echo "Setup complete."