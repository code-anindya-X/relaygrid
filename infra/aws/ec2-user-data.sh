#!/usr/bin/env bash
set -euo pipefail

exec > >(tee /var/log/relaygrid-bootstrap.log) 2>&1
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl git nginx openjdk-21-jdk python3 python3-venv openssl

curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

curl -fsSL https://get.docker.com | sh
systemctl enable --now docker nginx

rm -rf /opt/relaygrid
git clone --depth=1 https://github.com/code-anindya-X/relaygrid.git /opt/relaygrid
cd /opt/relaygrid
cp .env.example .env

replace_env() {
  local key="$1"
  local value="$2"
  sed -i "s|^${key}=.*|${key}=${value}|" .env
}

replace_env POSTGRES_PASSWORD "$(openssl rand -hex 24)"
database_password="$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)"
replace_env DATABASE_URL "postgresql://relaygrid:${database_password}@127.0.0.1:5432/relaygrid"
replace_env JDBC_URL "jdbc:postgresql://127.0.0.1:5432/relaygrid"
replace_env MCP_BEARER_TOKEN "$(openssl rand -hex 32)"
replace_env PROOFLINE_INTERNAL_TOKEN "$(openssl rand -hex 32)"
replace_env IMPACT_ENGINE_INTERNAL_TOKEN "$(openssl rand -hex 32)"
replace_env CONTROL_PLANE_INTERNAL_TOKEN "$(openssl rand -hex 32)"
replace_env CONSOLE_OPERATOR_ACCESS_CODE "$(openssl rand -hex 12)"
replace_env CONSOLE_SESSION_SECRET "$(openssl rand -hex 48)"
replace_env ALLOW_DEMO_MEMORY_ACTIONS false

./scripts/setup-local.sh --full

cat >/etc/systemd/system/relaygrid.service <<'EOF'
[Unit]
Description=RelayGrid hackathon stack
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/opt/relaygrid
Environment=HOME=/root
ExecStart=/opt/relaygrid/scripts/dev-up.sh
ExecStop=/opt/relaygrid/scripts/dev-down.sh
RemainAfterExit=yes
TimeoutStartSec=900

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/nginx/sites-available/relaygrid <<'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF

rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/relaygrid /etc/nginx/sites-enabled/relaygrid
nginx -t

systemctl daemon-reload
systemctl enable --now relaygrid
systemctl restart nginx

operator_code="$(grep '^CONSOLE_OPERATOR_ACCESS_CODE=' .env | cut -d= -f2-)"
metadata_token="$(curl -fsS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token || true)"
public_ip="$(curl -fsS -H "X-aws-ec2-metadata-token: ${metadata_token}" http://169.254.169.254/latest/meta-data/public-ipv4 || echo INSTANCE_PUBLIC_IP)"
cat >/root/relaygrid-deployment.txt <<EOF
RelayGrid is available at http://${public_ip}
Operator access code: ${operator_code}
Bootstrap log: /var/log/relaygrid-bootstrap.log
EOF

curl -fsS --retry 20 --retry-delay 3 --retry-connrefused http://127.0.0.1:5173 >/dev/null
echo "RelayGrid EC2 bootstrap complete"